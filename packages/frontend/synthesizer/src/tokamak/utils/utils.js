export const powMod = (base, exponent, modulus) => {
    if (modulus === 1n)
        return 0n;
    let result = 1n;
    base = base % modulus;
    while (exponent > 0n) {
        if (exponent % 2n === 1n) {
            result = (result * base) % modulus;
        }
        base = (base * base) % modulus;
        exponent = exponent >> 1n;
    }
    return result;
};
export const byteSize = (value) => {
    const hexLength = value.toString(16).length;
    return Math.max(Math.ceil(hexLength / 2), 1);
};
export const addPlacement = (map, value) => {
    const key = map.size;
    map.set(key, value);
};
// Convert to signed integer (256-bit)
export const convertToSigned = (value) => {
    const SIGN_BIT = 1n << 255n;
    return (value & SIGN_BIT) !== 0n ? value - (1n << 256n) : value;
};
// Debugging tool
export const mapToStr = (map) => {
    return Object.fromEntries(Array.from(map, ([key, value]) => [
        key,
        JSON.parse(JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? v.toString() : v))),
    ]));
};
// Debugging tool
export function arrToStr(key, value) {
    return typeof value === 'bigint' ? value.toString() : value;
}
export function split256BitInteger(value) {
    // Calculate the lower and upper parts
    const lower = (value & ((1n << 128n) - 1n)) % 2n ** 128n;
    const upper = (value >> 128n) % 2n ** 128n;
    return [lower, upper];
}
export const merge128BitIntegers = (low, high) => {
    // assume the inputs are in 128bit (Todo: check the input validity)
    return (high << 128n) + low;
};
