/**
 * India GST reference data and validation. Rates are never hardcoded here: they come
 * from tax codes with effective-dated versions (see features/finance/setup.ts).
 */

/** GST state / UT codes (place of supply). 96 = outside India (exports), 97 = other territory. */
export const GST_STATES: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "96": "Outside India",
  "97": "Other Territory",
};

export const isStateCode = (code: string | null | undefined) => Boolean(code && GST_STATES[code]);

const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Check character for the first 14 characters of a GSTIN (GSTN's mod-36 scheme). */
export function gstinCheckChar(first14: string) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = CHARSET.indexOf(first14[i]);
    if (value < 0) return null;
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36];
}

/** Format, state code and check digit. */
export function isValidGstin(gstin: string | null | undefined) {
  if (!gstin) return false;
  const value = gstin.trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(value)) return false;
  if (!isStateCode(value.slice(0, 2)) || value.startsWith("96") || value.startsWith("97")) return false;
  return gstinCheckChar(value.slice(0, 14)) === value[14];
}

/** HSN (goods) is 4/6/8 digits; SAC (services) is 6 digits starting with 99. */
export const isValidHsn = (code: string | null | undefined) => Boolean(code && /^(\d{4}|\d{6}|\d{8})$/.test(code));
