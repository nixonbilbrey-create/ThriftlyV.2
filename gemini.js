const PLATFORMS = ['Vinted', 'Depop', 'Poshmark', 'eBay'];
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
// Google's API by default. The override exists so tests can point the pipeline at
// a local fake instead of spending a real key's quota; leave it unset in production.
const API_BASE = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');

// Cheap validation call — lists models instead of generating anything, so connecting
// a key doesn't cost the user any generation quota.
async function testGeminiKey(apiKey) {
  const res = await fetch(`${API_BASE}/models`, { headers: { 'x-goog-api-key': apiKey } });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const err = new Error('Gemini rejected this key');
    err.status = 400;
    err.detail = detail;
    throw err;
  }
  return true;
}

// Calls generateContent with the given user's key, forcing JSON output, and parses it.
async function callGeminiJSON({ apiKey, system, parts, maxTokens = 800 }) {
  if (!apiKey) {
    const err = new Error('No Gemini API key connected — add one in Settings first');
    err.status = 400;
    throw err;
  }

  const res = await fetch(`${API_BASE}/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: maxTokens },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    const err = new Error('Gemini API error');
    err.status = res.status;
    err.detail = data;
    throw err;
  }

  const textParts = data.candidates?.[0]?.content?.parts?.filter(p => p.text) || [];
  if (!textParts.length) {
    const err = new Error('No text content in model response');
    err.status = 502;
    err.detail = data;
    throw err;
  }

  const raw = textParts.map(p => p.text).join('');
  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
    return JSON.parse(cleaned);
  } catch (parseErr) {
    const err = new Error('Model did not return valid JSON');
    err.status = 502;
    err.raw = raw;
    throw err;
  }
}

// ---------- prompts ----------
const ANALYZE_SYSTEM_PROMPT = `You are a resale pricing assistant for a secondhand clothing app. You look at one photo of a clothing item, identify it, and estimate what it would realistically sell for used on marketplaces like Vinted, Depop, Poshmark, and eBay.

You do not have live sold-listing data from those marketplaces — base your price estimate on your general knowledge of resale norms for this kind of item (brand tier, category, typical depreciation, condition). Keep "confidence" honest: use "low" whenever the brand or exact item isn't clearly identifiable from the photo.

Respond with a JSON object matching exactly this shape:
{
  "item_type": string,
  "brand": string or null if not identifiable,
  "category": string,
  "color": string,
  "material": string or null,
  "condition": "Like new" | "Excellent" | "Good" | "Fair" | "Poor",
  "condition_notes": string (what visible wear/flaws informed this),
  "estimated_price_low": number,
  "estimated_price_high": number,
  "currency": "USD",
  "confidence": "high" | "medium" | "low",
  "reasoning": string (2-3 sentences on how you arrived at the price range),
  "suggested_title": string (resale-listing-ready, under 80 characters),
  "suggested_keywords": array of 4-8 short search keywords
}`;

const LISTING_SYSTEM_PROMPT = `You are a resale copywriter. You'll be given structured details about a secondhand clothing item (already identified from a photo) and asked to draft a listing for four marketplaces: Vinted, Depop, Poshmark, and eBay.

Write to each platform's real norms, using the specific details you were given (condition notes, material, brand) rather than generic filler:
- Vinted: plain, practical tone. Buyers pay shipping separately, so be straightforwardly honest about condition. No emoji.
- Depop: casual, younger audience. Short punchy title, conversational description, at most 1-2 relevant emoji. Never more than that.
- Poshmark: structured description with clear line breaks calling out brand / size / condition; slightly polished "boutique" tone; sellers commonly offer bundle discounts, so it's fine to mention that.
- eBay: keyword-forward title for search (brand, item type, distinguishing details, condition); neutral, informative description; can mention shipping.

Also propose a specific asking price for each platform, grounded in the given price range but reflecting real seller behavior differences between platforms (for example: Poshmark listings are commonly priced a bit above the floor since offers/negotiation are expected there; Vinted listings tend to sit closer to the low end since it's a high-volume, price-sensitive marketplace). Stay within a reasonable distance of the given range — don't invent a wildly different number.

Respond with a JSON object matching exactly this shape:
{
  "Vinted":   { "title": string (<=80 chars), "description": string, "price": number },
  "Depop":    { "title": string (<=80 chars), "description": string, "price": number },
  "Poshmark": { "title": string (<=80 chars), "description": string, "price": number },
  "eBay":     { "title": string (<=80 chars), "description": string, "price": number }
}`;

function analyzeParts(base64, mimeType) {
  return [
    { text: 'Identify this clothing item and estimate its resale value. Return only the JSON object described in your instructions.' },
    { inlineData: { mimeType, data: base64 } },
  ];
}

function listingParts(analysis) {
  const details = {
    item_type: analysis.item_type, brand: analysis.brand ?? null, category: analysis.category ?? null,
    color: analysis.color ?? null, material: analysis.material ?? null, condition: analysis.condition ?? null,
    condition_notes: analysis.condition_notes ?? null, estimated_price_low: analysis.estimated_price_low ?? null,
    estimated_price_high: analysis.estimated_price_high ?? null, currency: analysis.currency || 'USD',
    suggested_keywords: analysis.suggested_keywords ?? [],
  };
  return [{ text: `Generate listing drafts for this item:\n${JSON.stringify(details, null, 2)}` }];
}

module.exports = {
  PLATFORMS, MODEL, testGeminiKey, callGeminiJSON,
  ANALYZE_SYSTEM_PROMPT, LISTING_SYSTEM_PROMPT, analyzeParts, listingParts,
};
