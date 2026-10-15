/**
 * checkout-client.js — Shared client for POST /api/checkout.
 * Used by the cart drawer and the /checkout page.
 */

const CART_KEY = 'index000_cart';

function readCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function showAlert(alertEl, message) {
  if (!alertEl) return;
  alertEl.textContent = message;
  alertEl.hidden = false;
}

export function clearAlert(alertEl) {
  if (!alertEl) return;
  alertEl.textContent = '';
  alertEl.hidden = true;
}

/**
 * @param {object} opts
 * @param {HTMLButtonElement[]} opts.buttons  Every checkout trigger to lock while pending.
 * @param {HTMLButtonElement}   opts.trigger  The button that was clicked (shows PROCESSING...).
 * @param {HTMLElement|null}    opts.alertEl  Inline alert container for errors.
 */
export async function startCheckout({ buttons, trigger, alertEl }) {
  clearAlert(alertEl);

  const cart = readCart();
  if (cart.length === 0) {
    showAlert(alertEl, 'Your bag is empty.');
    return;
  }

  const labels = new Map(buttons.map((b) => [b, b.textContent]));
  const unlock = () => {
    buttons.forEach((b) => {
      b.disabled = false;
      b.textContent = labels.get(b);
    });
  };

  buttons.forEach((b) => (b.disabled = true));
  trigger.textContent = 'PROCESSING...';

  try {
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: cart.map((item) => ({ id: item.id, size: item.size, quantity: item.quantity })),
      }),
    });

    let data = {};
    try {
      data = await res.json();
    } catch {
      /* non-JSON error body */
    }

    if (!res.ok || !data.url) {
      throw new Error(data.error || `Checkout failed (HTTP ${res.status}). Please try again.`);
    }

    // Stay locked while the browser navigates to Stripe.
    window.location.href = data.url;

    // Restore if the user returns via the back button (bfcache).
    window.addEventListener('pageshow', (e) => e.persisted && unlock(), { once: true });
  } catch (err) {
    unlock();
    showAlert(
      alertEl,
      err instanceof TypeError ? 'Network error. Check your connection and try again.' : err.message
    );
  }
}
