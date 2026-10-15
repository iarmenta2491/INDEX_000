import Stripe from 'stripe';
import products from '../../src/data/products.json';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const DEFAULT_WEIGHT_LB = 0.5;
const SHIPPING_COST = '6.00';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

/** Parse the "id:size:qty,id:size:qty" metadata written by /api/checkout. */
function parseCartMetadata(cart) {
  if (typeof cart !== 'string' || !cart) return [];
  return cart.split(',').map((entry) => {
    const [id, size, qty] = entry.split(':');
    const product = products.find((p) => p.id === id);
    const quantity = Number(qty);
    if (!product || !size || !Number.isInteger(quantity) || quantity < 1) {
      throw new Error(`Invalid cart metadata entry "${entry}".`);
    }
    return { product, size, quantity };
  });
}

/** Stripe moved shipping_details under collected_information in newer API versions. */
function resolveShipping(session) {
  const shipping =
    session.collected_information?.shipping_details || session.shipping_details || null;
  const customer = session.customer_details || {};
  const address = shipping?.address || customer.address;
  if (!address) return null;
  return {
    name: shipping?.name || customer.name || '',
    address,
    email: customer.email || session.customer_email || '',
    phone: customer.phone || '',
  };
}

function buildShippoOrder(session, items, shipping) {
  const lineItems = items.map(({ product, size, quantity }) => {
    const unitWeight = Number(product.weight) > 0 ? Number(product.weight) : DEFAULT_WEIGHT_LB;
    return {
      title: product.title,
      variant_title: size,
      sku: product.sku ? `${product.sku}-${size}` : `${product.id}-${size}`,
      quantity,
      total_price: (product.price * quantity).toFixed(2),
      currency: 'USD',
      weight: unitWeight.toString(),
      weight_unit: 'lb',
      _lineWeight: unitWeight * quantity,
    };
  });

  const totalWeight = lineItems.reduce((sum, li) => sum + li._lineWeight, 0);
  lineItems.forEach((li) => delete li._lineWeight);

  const { address } = shipping;
  return {
    to_address: {
      name: shipping.name,
      street1: address.line1 || '',
      street2: address.line2 || '',
      city: address.city || '',
      state: address.state || '',
      zip: address.postal_code || '',
      country: address.country || 'US',
      email: shipping.email,
      phone: shipping.phone,
    },
    line_items: lineItems,
    placed_at: new Date((session.created || Date.now() / 1000) * 1000).toISOString(),
    order_number: session.payment_intent || session.id,
    order_status: 'PAID',
    shipping_cost: SHIPPING_COST,
    shipping_cost_currency: 'USD',
    weight: totalWeight.toString(),
    weight_unit: 'lb',
  };
}

export async function onRequestPost(context) {
  const { env, request } = context;

  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET || !env.SHIPPO_API_TOKEN) {
    console.error('Webhook misconfigured: missing STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET or SHIPPO_API_TOKEN.');
    return json({ error: 'Server is missing required configuration.' }, 500);
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });

  // Signature verification needs the exact raw body.
  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return json({ error: 'Missing stripe-signature header.' }, 400);
  }

  let event;
  try {
    const cryptoProvider = Stripe.createSubtleCryptoProvider();
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      cryptoProvider
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return json({ error: `Webhook signature verification failed: ${err.message}` }, 400);
  }

  if (event.type !== 'checkout.session.completed') {
    return json({ received: true }, 200);
  }

  const session = event.data.object;

  // Delayed payment methods complete the session before funds arrive; don't fulfil unpaid orders.
  if (session.payment_status !== 'paid') {
    console.warn(`Session ${session.id} not paid (${session.payment_status}); skipping fulfilment.`);
    return json({ received: true, skipped: 'payment_not_completed' }, 200);
  }

  // Unrecoverable data problems return 200 so Stripe doesn't retry them for days; they are logged.
  let items;
  try {
    items = parseCartMetadata(session.metadata?.cart);
    if (items.length === 0) throw new Error('Session has no cart metadata.');
  } catch (err) {
    console.error(`Session ${session.id}: ${err.message}`);
    return json({ received: true, skipped: 'invalid_cart_metadata' }, 200);
  }

  const shipping = resolveShipping(session);
  if (!shipping) {
    console.error(`Session ${session.id}: no shipping address on session.`);
    return json({ received: true, skipped: 'missing_shipping_address' }, 200);
  }

  try {
    const shippoRes = await fetch('https://api.goshippo.com/orders/', {
      method: 'POST',
      headers: {
        Authorization: `ShippoToken ${env.SHIPPO_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildShippoOrder(session, items, shipping)),
    });

    const shippoData = await shippoRes.json().catch(() => ({}));

    if (!shippoRes.ok) {
      console.error(`Shippo order failed for ${session.id} (HTTP ${shippoRes.status}):`, JSON.stringify(shippoData));
      // 500 makes Stripe retry the webhook automatically.
      return json({ error: 'Shippo order creation failed.', status: shippoRes.status, details: shippoData }, 500);
    }

    return json({ received: true, shippo_order_id: shippoData.object_id }, 200);
  } catch (err) {
    console.error(`Shippo request error for ${session.id}:`, err);
    return json({ error: `Shippo request failed: ${err.message}` }, 500);
  }
}

// Reject any non-POST method.
export async function onRequest() {
  return new Response(JSON.stringify({ error: 'Method not allowed. Use POST.' }), {
    status: 405,
    headers: { ...JSON_HEADERS, Allow: 'POST' },
  });
}
