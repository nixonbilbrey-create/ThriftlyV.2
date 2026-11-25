#!/usr/bin/env node
// Seed a self-contained demo account for the walkthrough in docs/WALKTHROUGH.md.
// Creates (or resets) demo@thriftly.local, marks it verified, and adds two
// drafts with generated placeholder images — one with listings, one awaiting
// the "Generate listings" step. No Gemini call is made: the analysis/listings
// below are hand-written sample data so the UI can be toured without a key.
//
// Run with: npm run seed:demo   (safe to re-run; it replaces the demo account)
import crypto from 'node:crypto';
import sharp from 'sharp';
import dbModule from '../db.js';
import authModule from '../auth.js';
import photosModule from '../photos.js';

const { initDb, getUserByEmail, createUser, markUserVerified, listDrafts, clearDrafts,
  createDraft, updateDraft, deleteSessionsForUser, deleteEmailVerificationsForUser,
  deletePasswordResetsForUser, deleteUserRow } = dbModule;
const { hashPassword } = authModule;
const { savePhoto, deletePhoto, photoIdFromThumb } = photosModule;

const EMAIL = 'demo@thriftly.local';
const PASSWORD = 'demo-pass-1234';
const CONSENT_VERSION = '2026-11-25b'; // keep in sync with PRIVACY_VERSION in server.js

const PLATFORMS = ['Vinted', 'Depop', 'Poshmark', 'eBay'];

function coatPhoto() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">
    <rect width="1200" height="900" fill="#efe7dc"/>
    <rect x="425" y="170" width="350" height="580" rx="26" fill="#c8a982"/>
    <rect x="305" y="200" width="135" height="430" rx="42" fill="#c8a982"/>
    <rect x="760" y="200" width="135" height="430" rx="42" fill="#c8a982"/>
    <path d="M600 170 L515 300 L600 430 L685 300 Z" fill="#b8976f"/>
    <rect x="500" y="430" width="200" height="14" fill="#b8976f"/>
    <circle cx="628" cy="330" r="7" fill="#8a6b45"/>
    <circle cx="628" cy="380" r="7" fill="#8a6b45"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

function sneakerPhoto() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">
    <rect width="1200" height="900" fill="#e8eaed"/>
    <path d="M260 560 C300 460 420 430 520 470 L700 540 C790 565 880 570 940 585 L940 650 L260 650 Z" fill="#f7f7f8" stroke="#c9ccd1" stroke-width="6"/>
    <path d="M330 600 Q500 520 700 610" stroke="#b7bcc4" stroke-width="10" fill="none"/>
    <circle cx="760" cy="585" r="26" fill="#d7dade"/>
    <path d="M520 470 L590 520 L640 500 L600 455 Z" fill="#aeb4bd"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

const coatAnalysis = {
  item_type: 'Wool-blend overcoat',
  brand: 'COS',
  category: 'Outerwear / coats',
  color: 'Camel',
  material: 'Wool-polyamide blend',
  condition: 'Excellent',
  condition_notes: 'Light pilling at the cuffs; no stains, rips, or missing buttons.',
  estimated_price_low: 65,
  estimated_price_high: 95,
  currency: 'USD',
  confidence: 'medium',
  reasoning: 'COS outerwear holds resale value well, and camel is the most sought-after colourway. Comparable used coats in excellent condition typically clear $70-90 on resale platforms.',
  suggested_title: 'COS camel wool-blend overcoat, size M',
  suggested_keywords: ['cos coat', 'camel overcoat', 'wool blend', 'minimalist outerwear', 'size m'],
};

const coatListings = {
  Vinted: {
    title: 'COS camel wool-blend overcoat — size M',
    description: 'Beautiful camel COS overcoat in excellent condition. Light pilling at the cuffs (pictured), otherwise no flaws. Warm wool-polyamide blend, good for layering. From a smoke-free home.',
    price: 72,
  },
  Depop: {
    title: 'COS camel overcoat — size M, clean',
    description: 'the perfect camel coat 🐪 COS wool blend, excellent condition apart from light cuff pilling. Sits oversized on a small/medium — check measurements. Open to offers.',
    price: 80,
  },
  Poshmark: {
    title: 'COS Camel Wool-Blend Overcoat Size M',
    description: 'Brand: COS\nSize: M\nCondition: Excellent\n\nBeautiful camel overcoat in a wool-polyamide blend. Light pilling at the cuffs; no stains, tears, or missing buttons. Timeless silhouette that layers well. Bundle for a discount!',
    price: 88,
  },
  eBay: {
    title: 'COS Camel Wool Blend Overcoat Coat Size M Excellent Condition',
    description: 'COS camel wool-blend overcoat, size M. excellent used condition — light pilling at cuffs only. Fast shipping. See photos for details and measurements.',
    price: 84,
  },
};

const sneakerAnalysis = {
  item_type: 'Air Max 90 sneakers',
  brand: 'Nike',
  category: 'Shoes / sneakers',
  color: 'White / grey',
  material: 'Leather and mesh',
  condition: 'Good',
  condition_notes: 'Visible creasing across the toe box and minor discolouration on the midsole; outsoles still have tread.',
  estimated_price_low: 45,
  estimated_price_high: 70,
  currency: 'USD',
  confidence: 'high',
  reasoning: 'Air Max 90 is a perennial seller in neutral colourways. Good-condition pairs with clean uppers usually land in the $50-65 range; creasing and midsole wear put this pair mid-range.',
  suggested_title: 'Nike Air Max 90 white/grey sneakers',
  suggested_keywords: ['air max 90', 'nike sneakers', 'white grey', 'running shoes', 'retro'],
};

async function main() {
  const db = initDb(process.env.DB_PATH);

  // Reset: remove the previous demo account and its photos so re-runs are clean.
  const existing = await getUserByEmail(db, EMAIL);
  if (existing) {
    for (const draft of await listDrafts(db, existing.id)) {
      const photoId = photoIdFromThumb(draft.thumb);
      if (photoId) await deletePhoto(photoId);
    }
    await clearDrafts(db, existing.id);
    await deleteSessionsForUser(db, existing.id);
    await deleteEmailVerificationsForUser(db, existing.id);
    await deletePasswordResetsForUser(db, existing.id);
    await deleteUserRow(db, existing.id);
  }

  const id = crypto.randomBytes(8).toString('hex');
  const user = await createUser(db, {
    id, email: EMAIL, passwordHash: await hashPassword(PASSWORD),
    consentVersion: CONSENT_VERSION, consentAt: Date.now(),
  });
  await markUserVerified(db, user.id);

  const coat = await savePhoto(await coatPhoto(), 'image/jpeg');
  const coatDraft = await createDraft(db, user.id, {
    analysis: coatAnalysis, thumb: coat.url, selected: PLATFORMS,
  });
  await updateDraft(db, user.id, coatDraft.id, {
    listings: Object.fromEntries(Object.entries(coatListings).map(([platform, fields]) => [
      platform, { ...fields, posted: platform === 'Vinted' },
    ])),
  });

  const sneakers = await savePhoto(await sneakerPhoto(), 'image/jpeg');
  await createDraft(db, user.id, {
    analysis: sneakerAnalysis, thumb: sneakers.url, selected: PLATFORMS,
  });

  await db.close();
  console.log('demo account ready');
  console.log(`  email:    ${EMAIL}`);
  console.log(`  password: ${PASSWORD}`);
  console.log(`  drafts:   2 (one with 4 listings, one awaiting "Generate listings")`);
  console.log(`  photo ids: ${coat.photoId}, ${sneakers.photoId}`);
  console.log('  try it:   log in at the running app, or `npm run seed:demo` to reset');
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
