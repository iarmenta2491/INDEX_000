import Stripe from 'stripe';
import products from '../../src/data/products.json';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const MAX_QTY_PER_LINE = 10;

/** Error carrying an HTTP status so validation failures map to 4xx. */
class CheckoutError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

/**
 * Zero-trust cart validation. Only id/size/quantity are read from the client;
 * names, prices and stock all come from the backend catalog.
 */
function buildVerifiedCart(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new CheckoutError('Cart is empty or malformed.');
  }

  // Merge duplicate id+size lines so stock is checked against the combined quantity.
  const merged = new Map();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || typeof item.size !== 'string') {
      throw new CheckoutError('Each cart item requires a string id and size.');
    }
    const quantity = item.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY_PER_LINE) {
      throw new CheckoutError(
        `Invalid quantity for item ${item.id}. Must be a whole number between 1 and ${MAX_QTY_PER_LINE}.`
      );
    }
    const key = `${item.id}|${item.size}`;
    const existing = merged.get(key);
    if (existing) existing.quantity += quantity;
    else merged.set(key, { id: item.id, size: item.size, quantity });
  }

  return [...merged.values()].map(({ id, size, quantity }) => {
    const product = products.find((p) => p.id === id);
    if (!product) {
      throw new CheckoutError(`Item ${id} does not exist.`);
    }
    if (!Object.prototype.hasOwnProperty.call(product.sizes, size)) {
      throw new CheckoutError(`Size ${size} is not available for ${product.title}.`);
    }
    const stock = product.sizes[size];
    if (!(stock > 0)) {
      throw new CheckoutError(`Item ${product.title} is currently out of stock.`);
    }
    if (quantity > stock) {
      throw new CheckoutError(
        `Only ${stock} of ${product.title} (size ${size}) remaining. Please reduce your quantity.`
      );
    }
    return { product, size, quantity };
  });
}

export async function onRequestPost(context) {
  try {
    if (!context.env.STRIPE_SECRET_KEY) {
      throw new CheckoutError('Server is missing STRIPE_SECRET_KEY configuration.', 500);
    }

    const stripe = new Stripe(context.env.STRIPE_SECRET_KEY, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    let payload;
    try {
      payload = await context.request.json();
    } catch {
      throw new CheckoutError('Request body must be valid JSON.');
    }

    const verified = buildVerifiedCart(payload?.items);

    const line_items = verified.map(({ product, size, quantity }) => ({
      quantity,
      price_data: {
        currency: 'usd',
        unit_amount: Math.round(product.price * 100), // catalog price, never client price
        product_data: {
          name: `${product.title} — ${size}`,
          description: `${product.subtitle} / ${product.color}`,
        },
      },
    }));

    // Compact "id:size:qty" list (Stripe metadata values max 500 chars).
    const cart = verified.map(({ product, size, quantity }) => `${product.id}:${size}:${quantity}`).join(',');
    if (cart.length > 500) {
      throw new CheckoutError('Cart is too large to process.');
    }

    const origin = new URL(context.request.url).origin;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      shipping_address_collection: { allowed_countries: ['US'] },
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 600, currency: 'usd' },
            display_name: 'Flat Rate Ground Shipping',
          },
        },
      ],
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/cart`,
      metadata: { cart },
      payment_intent_data: { metadata: { cart } },
    });

    return json({ url: session.url }, 200);
  } catch (err) {
    if (err instanceof CheckoutError) {
      return json({ error: err.message }, err.status);
    }
    console.error('Checkout error:', err);
    return json({ error: `Checkout failed: ${err?.message || 'Unknown error'}` }, 500);
  }
}

// Reject any non-POST method.
export async function onRequest() {
  return new Response(JSON.stringify({ error: 'Method not allowed. Use POST.' }), {
    status: 405,
    headers: { ...JSON_HEADERS, Allow: 'POST' },
  });
}
