/**
 * INDEX_000 — Cart & Inventory Logic
 * Client-side cart management with localStorage persistence
 * and inventory hard-stop enforcement.
 */

const CART_KEY = 'index000_cart';
const SHIPPING_FLAT_RATE = 6.00;

/**
 * @typedef {Object} CartItem
 * @property {string} id
 * @property {string} slug
 * @property {string} title
 * @property {string} size
 * @property {number} price
 * @property {number} quantity
 * @property {string} image
 */

/**
 * Get the current cart from localStorage
 * @returns {CartItem[]}
 */
export function getCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Save cart to localStorage and dispatch update event
 * @param {CartItem[]} cart
 */
export function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  window.dispatchEvent(new CustomEvent('cart-updated', { detail: { cart } }));
  updateCartCount();
}

/**
 * Add item to cart with inventory check
 * @param {CartItem} item
 * @param {number} maxInventory - max available for this size
 * @returns {{ success: boolean, message: string }}
 */
export function addToCart(item, maxInventory) {
  const cart = getCart();
  const existingIndex = cart.findIndex(
    (ci) => ci.id === item.id && ci.size === item.size
  );

  if (existingIndex >= 0) {
    const existing = cart[existingIndex];
    if (existing.quantity >= maxInventory) {
      return { success: false, message: 'INVENTORY LIMIT REACHED' };
    }
    cart[existingIndex].quantity += 1;
  } else {
    if (maxInventory <= 0) {
      return { success: false, message: 'OUT OF STOCK' };
    }
    cart.push({ ...item, quantity: 1 });
  }

  saveCart(cart);
  return { success: true, message: 'ADDED TO BAG' };
}

/**
 * Update item quantity in cart
 * @param {string} id
 * @param {string} size
 * @param {number} newQuantity
 */
export function updateQuantity(id, size, newQuantity) {
  let cart = getCart();
  if (newQuantity <= 0) {
    cart = cart.filter((ci) => !(ci.id === id && ci.size === size));
  } else {
    const index = cart.findIndex((ci) => ci.id === id && ci.size === size);
    if (index >= 0) {
      cart[index].quantity = newQuantity;
    }
  }
  saveCart(cart);
}

/**
 * Remove item from cart
 * @param {string} id
 * @param {string} size
 */
export function removeFromCart(id, size) {
  let cart = getCart();
  cart = cart.filter((ci) => !(ci.id === id && ci.size === size));
  saveCart(cart);
}

/**
 * Clear the entire cart
 */
export function clearCart() {
  saveCart([]);
}

/**
 * Calculate cart totals
 * @returns {{ subtotal: number, shipping: number, total: number, itemCount: number }}
 */
export function getCartTotals() {
  const cart = getCart();
  const itemCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const shipping = itemCount > 0 ? SHIPPING_FLAT_RATE : 0;
  const total = subtotal + shipping;
  return { subtotal, shipping, total, itemCount };
}

/**
 * Update the cart count badge in the header
 */
export function updateCartCount() {
  const { itemCount } = getCartTotals();
  const badge = document.getElementById('cart-count');
  if (badge) {
    badge.textContent = itemCount > 0 ? String(itemCount) : '';
    badge.style.display = itemCount > 0 ? 'inline-flex' : 'none';
  }
}

/**
 * Format price as USD
 * @param {number} amount
 * @returns {string}
 */
export function formatPrice(amount) {
  return `$${amount.toFixed(2)}`;
}

/**
 * Check if a product+size combination can be added
 * @param {string} productId
 * @param {string} size
 * @param {number} maxInventory
 * @returns {boolean}
 */
export function canAddToCart(productId, size, maxInventory) {
  const cart = getCart();
  const existing = cart.find((ci) => ci.id === productId && ci.size === size);
  const currentInCart = existing ? existing.quantity : 0;
  return currentInCart < maxInventory;
}

/**
 * Detect express payment availability
 * @returns {{ applePay: boolean, googlePay: boolean }}
 */
export function detectExpressPayments() {
  const applePay = !!(window.ApplePaySession && ApplePaySession.canMakePayments());
  const googlePay = /android/i.test(navigator.userAgent);
  return { applePay, googlePay };
}

// Initialize cart count on page load
if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    updateCartCount();
  });
}
