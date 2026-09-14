// Vendored from `fractional-indexing` (MIT, David Greenspan / rocicorp).
// Generates order keys that sort correctly under plain lexicographic `<`.
// See spec §5 — do not hand-roll this; the edge cases (adjacent keys,
// integer-part overflow) are exactly what this vendored version already
// handles correctly.

const BASE_62_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function integerLength(head) {
  if (head >= 'a' && head <= 'z') {
    return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  } else if (head >= 'A' && head <= 'Z') {
    return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  } else {
    throw new Error('invalid order key head: ' + head);
  }
}

function validateInteger(int) {
  if (int.length !== integerLength(int[0])) {
    throw new Error('invalid integer part of order key: ' + int);
  }
}

function getIntegerPart(key) {
  const integerPartLength = integerLength(key[0]);
  if (integerPartLength > key.length) {
    throw new Error('invalid order key: ' + key);
  }
  return key.slice(0, integerPartLength);
}

function validateOrderKey(key) {
  if (key === 'A' + '0'.repeat(26)) {
    throw new Error('invalid order key: ' + key);
  }
  const i = getIntegerPart(key);
  const f = key.slice(i.length);
  if (f.slice(-1) === '0') {
    throw new Error('invalid order key: ' + key);
  }
}

// Returns null if there is no larger integer part representable.
function incrementInteger(x, digits) {
  validateInteger(x);
  const [head, ...digs] = x.split('');
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = digits.indexOf(digs[i]) + 1;
    if (d === digits.length) {
      digs[i] = '0';
    } else {
      digs[i] = digits[d];
      carry = false;
    }
  }
  if (carry) {
    if (head === 'Z') {
      return 'a' + '0'.repeat(digs.length + 1);
    }
    if (head === 'z') {
      return null;
    }
    const h = String.fromCharCode(head.charCodeAt(0) + 1);
    if (h > 'a') {
      digs.push('0');
    } else {
      digs.pop();
    }
    return h + digs.join('');
  } else {
    return head + digs.join('');
  }
}

// Returns null if there is no smaller integer part representable.
function decrementInteger(x, digits) {
  validateInteger(x);
  const [head, ...digs] = x.split('');
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = digits.indexOf(digs[i]) - 1;
    if (d === -1) {
      digs[i] = digits.slice(-1);
    } else {
      digs[i] = digits[d];
      borrow = false;
    }
  }
  if (borrow) {
    if (head === 'a') {
      return 'Z' + '9'.repeat(digs.length + 1);
    }
    if (head === 'A') {
      return null;
    }
    const h = String.fromCharCode(head.charCodeAt(0) - 1);
    if (h < 'Z') {
      digs.push(digits.slice(-1));
    } else {
      digs.pop();
    }
    return h + digs.join('');
  } else {
    return head + digs.join('');
  }
}

function midpoint(a, b, digits) {
  if (b != null && a >= b) {
    throw new Error(a + ' >= ' + b);
  }
  if (a.slice(-1) === '0' || (b && b.slice(-1) === '0')) {
    throw new Error('trailing zero');
  }
  if (b) {
    let n = 0;
    while ((a[n] || '0') === b[n]) {
      n++;
    }
    if (n > 0) {
      return b.slice(0, n) + midpoint(a.slice(n), b.slice(n), digits);
    }
  }
  const digitA = a ? digits.indexOf(a[0]) : 0;
  const digitB = b != null ? digits.indexOf(b[0]) : digits.length;
  if (digitB - digitA > 1) {
    const midDigit = Math.round(0.5 * (digitA + digitB));
    return digits[midDigit];
  } else {
    if (b && b.length > 1) {
      return b.slice(0, 1);
    } else {
      const rest = midpoint(a.slice(1), null, digits);
      return digits[digitA] + rest;
    }
  }
}

/**
 * Generates a key that sorts strictly between `a` and `b` under
 * lexicographic `<`. Pass `null` for either bound to append/prepend.
 */
export function generateKeyBetween(a, b, digits = BASE_62_DIGITS) {
  if (a != null) validateOrderKey(a);
  if (b != null) validateOrderKey(b);
  if (a != null && b != null && a >= b) {
    throw new Error(a + ' >= ' + b);
  }
  if (a == null) {
    if (b == null) {
      return 'a0';
    }
    const ib = getIntegerPart(b);
    const fb = b.slice(ib.length);
    if (ib === 'A' + '0'.repeat(26)) {
      return ib + midpoint('', fb, digits);
    }
    if (ib < b) {
      return ib;
    }
    const res = decrementInteger(ib, digits);
    if (res == null) {
      throw new Error('cannot decrement any more');
    }
    return res;
  }
  if (b == null) {
    const ia = getIntegerPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInteger(ia, digits);
    return i == null ? ia + midpoint(fa, null, digits) : i;
  }
  const ia = getIntegerPart(a);
  const fa = a.slice(ia.length);
  const ib = getIntegerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) {
    return ia + midpoint(fa, fb, digits);
  }
  const i = incrementInteger(ia, digits);
  if (i == null) {
    throw new Error('cannot increment any more');
  }
  if (i < b) {
    return i;
  }
  return ia + midpoint(fa, null, digits);
}
