require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
// Cloudinary — npm install cloudinary
let cloudinary;
try {
  cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
} catch(e) { console.warn('⚠️ cloudinary non installé — npm install cloudinary'); }
const { MongoClient } = require('mongodb');
const { Resend } = require('resend');

// Stripe — installer avec: npm install stripe
let stripe;
try {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
} catch(e) {
  console.warn('⚠️ stripe non installé — npm install stripe');
}

// Plans Simpl
const STRIPE_PRICES = {
  soumission: process.env.STRIPE_PRICE_SOUMISSION || 'price_1TfBNXPOFpFVzIWVY8BMqQC1',
  boutique:   process.env.STRIPE_PRICE_BOUTIQUE   || 'price_1TfBPDPOFpFVzIWVlCzZIQZe',
};

// Packages de sécurité — installer avec: npm install bcryptjs helmet express-rate-limit
let bcrypt, helmet, rateLimit;
try { bcrypt = require('bcryptjs'); } catch(e) { console.warn('⚠️ bcryptjs non installé — mots de passe moins sécurisés'); }
try { helmet = require('helmet'); } catch(e) { console.warn('⚠️ helmet non installé'); }
try { rateLimit = require('express-rate-limit'); } catch(e) { console.warn('⚠️ express-rate-limit non installé'); }

const app = express();
app.set('trust proxy', 1); // Railway utilise un proxy
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── SÉCURITÉ ─────────────────────────────────────────────────────────────────

// Headers de sécurité
if(helmet) app.use(helmet({ contentSecurityPolicy: false }));

// CORS — restreint aux domaines Simpl
const allowedOrigins = [
  'https://simplcomerce.com',
  'https://www.simplcomerce.com',
  'https://simpl-production.up.railway.app',
  'http://localhost:3000',
  'http://localhost:8080'
];
app.use(cors({
  origin: (origin, cb) => {
    if(!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(null, false);
  }
}));

// Rate limiting — login/register : 10 tentatives par 15 min par IP
const loginLimiter = rateLimit ? rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives. Réessaie dans 15 minutes.' },
  standardHeaders: true, legacyHeaders: false,
}) : (req, res, next) => next();

// Rate limiting général API — 200 req/min par IP
const apiLimiter = rateLimit ? rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: 'Trop de requêtes.' },
}) : (req, res, next) => next();

app.use('/api/', apiLimiter);

// ─── STRIPE WEBHOOK — doit être avant express.json() ────────────────────────
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if(!stripe) return res.status(500).json({ error: 'Stripe non configuré' });
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if(!webhookSecret) {
    console.warn('⚠️ STRIPE_WEBHOOK_SECRET non défini — webhook non sécurisé');
    return res.status(500).json({ error: 'Webhook secret manquant' });
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch(e) {
    console.error('Webhook signature invalide:', e.message);
    return res.status(400).json({ error: 'Webhook invalide' });
  }
  // Abonnement créé ou activé (après trial ou paiement)
  if(event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const userId = sub.metadata?.userId;
    const slug = sub.metadata?.slug;
    const status = sub.status; // active, trialing, past_due, canceled
    const priceId = sub.items?.data?.[0]?.price?.id;
    const plan = priceId === STRIPE_PRICES.boutique ? 'boutique' : 'soumission';
    const paid = (status === 'active' || status === 'trialing');
    try {
      if(slug) {
        const v = await getVendor(slug);
        if(v) {
          v.plan = plan;
          v.paid = paid;
          v.subscriptionId = sub.id;
          v.subscriptionStatus = status;
          v.store = v.store || {};
          v.store.mode = plan;
          await saveVendor(v);
        }
      }
      if(userId) {
        await db.collection('users').updateOne(
          { _id: require('mongodb').ObjectId.createFromHexString(userId) },
          { $set: { plan, paid, subscriptionId: sub.id, subscriptionStatus: status } }
        );
      }
    } catch(e) { console.error('Webhook billing error:', e.message); }
  }

  // Abonnement annulé ou expiré
  if(event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const slug = sub.metadata?.slug;
    const userId = sub.metadata?.userId;
    try {
      if(slug) {
        const v = await getVendor(slug);
        if(v) { v.paid = false; v.subscriptionStatus = 'canceled'; await saveVendor(v); }
      }
      if(userId) {
        await db.collection('users').updateOne(
          { _id: require('mongodb').ObjectId.createFromHexString(userId) },
          { $set: { paid: false, subscriptionStatus: 'canceled' } }
        );
      }
    } catch(e) {}
  }

  res.json({ received: true });
});


app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static('uploads'));
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ─── SANITISATION ─────────────────────────────────────────────────────────────

// Nettoyer les strings pour éviter XSS et injection NoSQL
function sanitize(str, maxLen = 500) {
  if(typeof str !== 'string') return str;
  return str
    .slice(0, maxLen)
    .replace(/<script[^>]*>.*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\$where|\$gt|\$lt|\$ne|\$in|\$exists/gi, '')
    .trim();
}

function sanitizeObj(obj, maxLen = 500) {
  if(typeof obj === 'string') return sanitize(obj, maxLen);
  if(typeof obj === 'number') return obj;
  if(typeof obj === 'boolean') return obj;
  if(Array.isArray(obj)) return obj.map(i => sanitizeObj(i, maxLen));
  if(obj && typeof obj === 'object'){
    const clean = {};
    for(const [k, v] of Object.entries(obj)){
      if(k.startsWith('$')) continue; // Bloquer les opérateurs MongoDB
      clean[k] = sanitizeObj(v, maxLen);
    }
    return clean;
  }
  return obj;
}

// Middleware sanitisation automatique
app.use((req, res, next) => {
  if(req.body && typeof req.body === 'object'){
    req.body = sanitizeObj(req.body);
  }
  next();
});

// ─── HASH MOT DE PASSE ────────────────────────────────────────────────────────

async function hashPassword(pwd) {
  if(bcrypt) return bcrypt.hash(pwd, 12);
  // Fallback si bcrypt pas installé — PBKDF2 qui est quand même bien meilleur que SHA256
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(pwd, 'simpl_salt_2024_secure', 100000, 64, 'sha256', (err, key) => {
      if(err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}

async function verifyPassword(pwd, hash) {
  if(bcrypt){
    // Support migration — si ancien hash SHA256 (64 chars hex sans $2b$)
    if(!hash.startsWith('$2b$')){
      const oldHash = crypto.createHash('sha256').update(pwd + 'simpl_salt_2024').digest('hex');
      if(oldHash === hash) return true;
    }
    return bcrypt.compare(pwd, hash);
  }
  // Fallback PBKDF2
  try {
    const newHash = await hashPassword(pwd);
    const a = Buffer.from(newHash);
    const b = Buffer.from(hash);
    if(a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch(e) {
    return false;
  }
}

function genAuthToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Valider email
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

// Valider slug
function isValidSlug(slug) {
  return /^[a-z0-9-]{2,50}$/.test(slug);
}



// ─── MONGODB ───
const MONGO_URI = process.env.MONGODB_URI;
let db;

async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('simpl');
  console.log('✅ MongoDB connecté');
}

async function getVendor(slug) {
  return db.collection('stores').findOne({ slug });
}

async function saveVendor(vendor) {
  await db.collection('stores').updateOne(
    { slug: vendor.slug },
    { $set: vendor },
    { upsert: true }
  );
}

// ─── MULTER ───
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if(ALLOWED_MIME_TYPES.includes(file.mimetype) && ALLOWED_EXTENSIONS.includes(ext)){
    cb(null, true);
  } else {
    cb(new Error('Seulement les images sont acceptées (JPG, PNG, WebP, GIF)'), false);
  }
};

// memoryStorage pour Cloudinary
const storage = multer.memoryStorage();
const _diskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const slug = req.params.slug || 'tmp';
    const dir = 'uploads/' + slug;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, crypto.randomBytes(8).toString('hex') + ext);
  }
});
const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// ─── HELPERS ───
function extractJSON(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON found');
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.substring(start, i + 1));
    }
  }
  throw new Error('Invalid JSON');
}

function genId() { return crypto.randomBytes(4).toString('hex'); }

async function authVendor(req, res) {
  const v = await getVendor(req.params.slug);
  if (!v || v.token !== req.headers['x-token']) {
    res.status(403).json({ error: 'Accès refusé' });
    return null;
  }
  return v;
}

// ─── EMAILS ───
const ADMIN_EMAIL = 'wtalbot442@gmail.com';

async function sendEmail({ to, subject, html }) {
  try {
    await resend.emails.send({
      from: 'Simpl <no-reply@simplcomerce.com>',
      to,
      subject,
      html
    });
  } catch(e) {
    console.error('Email error:', e.message);
    // On log l'erreur mais on crashe pas l'app
  }
}

// Email 1 : Confirmation de création de boutique → à l'entrepreneur
async function emailBoutiqueCreee(vendor, slug, token) {
  const dashboardUrl = `https://simpl-production.up.railway.app/dashboard/${slug}/${token}`;
  const storeUrl = `https://simpl-production.up.railway.app/s/${slug}`;
  await sendEmail({
    to: vendor.email,
    subject: '🎉 Ta boutique Simpl est prête !',
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:32px;">
        <h1 style="color:#10b981;">Bienvenue sur Simpl, ${vendor.businessName} !</h1>
        <p>Ta boutique est en ligne et prête à recevoir des commandes.</p>
        <h3>Tes liens importants :</h3>
        <p>🛒 <strong>Ta boutique :</strong> <a href="${storeUrl}">${storeUrl}</a></p>
        <p>⚙️ <strong>Ton dashboard :</strong> <a href="${dashboardUrl}">${dashboardUrl}</a></p>
        <p style="color:#ef4444;font-size:13px;">⚠️ Garde le lien dashboard précieusement — c'est ton accès unique.</p>
        <br/>
        <p style="color:#6b7280;font-size:13px;">L'équipe Simpl</p>
      </div>
    `
  });
}

// Email 2 : Nouvelle commande → à l'entrepreneur
async function emailNouvelleCommande(vendor, order) {
  const dashboardUrl = `https://simpl-production.up.railway.app/dashboard/${vendor.slug}/${vendor.token}`;
  const clientName = order.clientName || order.name || 'N/A';
  const clientEmail = order.clientEmail || order.email || 'N/A';
  const clientPhone = order.clientPhone || order.phone || 'N/A';
  const items = (order.items || []).map(i => `<li>${i.qty}x ${i.prodNom} — ${i.prixTotal || ''}$</li>`).join('');
  await sendEmail({
    to: vendor.email,
    subject: `📦 Nouvelle commande — ${vendor.businessName}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:32px;">
        <h1 style="color:#10b981;">Nouvelle commande reçue !</h1>
        <p><strong>Client :</strong> ${clientName}</p>
        <p><strong>Email :</strong> ${clientEmail}</p>
        <p><strong>Téléphone :</strong> ${clientPhone}</p>
        <h3>Produits commandés :</h3>
        <ul>${items || '<li>Voir le dashboard pour les détails</li>'}</ul>
        <br/>
        <a href="${dashboardUrl}" style="background:#10b981;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;">Voir dans mon dashboard</a>
        <br/><br/>
        <p style="color:#6b7280;font-size:13px;">L'équipe Simpl</p>
      </div>
    `
  });
}

// Email 3 : Confirmation de commande → au client final
async function emailConfirmationClient(order, vendor) {
  const clientEmail = order.clientEmail || order.email;
  const clientName = order.clientName || order.name || '';
  if (!clientEmail) return;
  order = { ...order, clientEmail, clientName };
  await sendEmail({
    to: order.clientEmail,
    subject: `✅ Commande confirmée — ${vendor.businessName}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:32px;">
        <h1 style="color:#10b981;">Ta commande est confirmée !</h1>
        <p>Bonjour ${order.clientName || ''},</p>
        <p>Ta commande chez <strong>${vendor.businessName}</strong> a bien été reçue.</p>
        <p>${vendor.businessName} va te contacter prochainement pour les détails.</p>
        ${vendor.phone ? `<p>📞 Téléphone : ${vendor.phone}</p>` : ''}
        <br/>
        <p style="color:#6b7280;font-size:13px;">Merci de ta confiance !</p>
      </div>
    `
  });
}

// Email 4 : Changement de statut → au client final
async function emailStatutCommande(order, vendor, nouveauStatut) {
  if (!order.clientEmail) return;
  const labels = {
    'en_cours': '🔄 En cours de traitement',
    'complete': '✅ Complétée',
    'annule': '❌ Annulée'
  };
  const label = labels[nouveauStatut] || nouveauStatut;
  await sendEmail({
    to: order.clientEmail,
    subject: `Mise à jour de ta commande — ${vendor.businessName}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:32px;">
        <h1 style="color:#10b981;">Mise à jour de ta commande</h1>
        <p>Bonjour ${order.clientName || ''},</p>
        <p>Le statut de ta commande chez <strong>${vendor.businessName}</strong> a changé :</p>
        <p style="font-size:20px;font-weight:bold;">${label}</p>
        ${order.note ? `<p><strong>Note :</strong> ${order.note}</p>` : ''}
        ${vendor.phone ? `<p>📞 Questions ? ${vendor.phone}</p>` : ''}
        <br/>
        <p style="color:#6b7280;font-size:13px;">L'équipe Simpl</p>
      </div>
    `
  });
}

// Email 5 : Notification admin (toi) → nouvelle boutique créée
async function emailAdminNouvelleBoutique(vendor, slug) {
  await sendEmail({
    to: ADMIN_EMAIL,
    subject: `🆕 Nouvelle boutique — ${vendor.businessName}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:32px;">
        <h2>Nouvelle boutique créée sur Simpl</h2>
        <p><strong>Nom :</strong> ${vendor.businessName}</p>
        <p><strong>Email :</strong> ${vendor.email}</p>
        <p><strong>Téléphone :</strong> ${vendor.phone || 'N/A'}</p>
        <p><strong>Ville :</strong> ${vendor.city || 'N/A'}</p>
        <p><strong>Slug :</strong> ${slug}</p>
        <p><strong>Date :</strong> ${new Date().toLocaleString('fr-CA')}</p>
      </div>
    `
  });
}

// ─── AI ROUTES ───
app.post('/api/start', async (req, res) => {
  const { service, lang = 'fr' } = req.body;
  const prompt = lang === 'fr'
    ? `Tu es un consultant business expert. Un entrepreneur crée une boutique pour: "${service}". Écris un message d'accueil naturel (2 phrases max) qui montre que tu comprends son domaine, et pose UNE seule question ouverte sur ses produits/prix. Réponds UNIQUEMENT en JSON: {"message": "..."}`
    : `You are an expert business consultant. An entrepreneur is creating a store for: "${service}". Write a natural welcome message (2 sentences max) showing you understand their field, and ask ONE open question about their products/prices. Reply ONLY in JSON: {"message": "..."}`;
  try {
    const msg = await groq.chat.completions.create({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 200, temperature: 0.8 });
    res.json(extractJSON(msg.choices[0].message.content));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chat', async (req, res) => {
  const { service, conversation, lang = 'fr' } = req.body;
  const history = conversation.map(m => `${m.role === 'user' ? 'Entrepreneur' : 'Simpl'}: ${m.content}`).join('\n');
  const userCount = conversation.filter(m => m.role === 'user').length;

  const template = `{
  "type": "store",
  "store": {
    "slogan": "slogan court et accrocheur",
    "description": "description 1-2 phrases du business",
    "mode": "soumission",
    "produits": [
      {
        "id": "prod1",
        "nom": "Nom vendeur du produit",
        "description": "description courte avec bénéfice principal",
        "prix_base": 25,
        "prix_affiche": "25$",
        "image_emoji": "🕯️",
        "image_url": "",
        "variantes": [],
        "options": []
      }
    ],
    "questions_client": [{"id": "q1", "question": "Question au client", "placeholder": "Ex: ..."}],
    "paiement": {"depot_pct": 0, "depot_label": "Dépôt", "solde_label": "Solde", "note": ""},
    "apparence": {"couleur_accent": "#7c6dfa", "logo_url": "", "banniere_url": "", "font": "Inter", "theme": "moderne"},
    "url_slug": "motcourt",
    "langue": "${lang}"
  }
}`;

  const prompt = lang === 'fr'
    ? `Tu es l'assistant de configuration intelligent de Simpl — une plateforme SaaS québécoise de création de boutiques en ligne et formulaires de soumission.

# MISSION

Configurer une boutique complète, crédible, professionnelle et prête à vendre en moins de 5 minutes.

Ton objectif n'est PAS d'obtenir toutes les informations possibles.

Ton objectif est de créer une boutique fonctionnelle le plus rapidement possible.

Tu privilégies toujours l'action plutôt que la collecte d'informations.

Tu construis d'abord. Tu ajustes ensuite. Tu ne bloques jamais la progression.

# RÈGLE D'OR

Une seule question par message. Jamais deux. Jamais une liste de questions. Jamais une question principale accompagnée d'une sous-question.

# PHILOSOPHIE

Chaque question doit apporter une information essentielle et irremplaçable. Si une information n'empêche pas la boutique de fonctionner, ne la demande pas. Tu fais des hypothèses intelligentes lorsque nécessaire. Tu annonces tes hypothèses en une phrase courte : "Je pars avec cette option pour avancer rapidement, on ajustera au besoin." Tu continues automatiquement sans attendre une validation.

# PRIORITÉ ABSOLUE

Ne jamais bloquer la création de la boutique. Si une information manque : estime intelligemment, utilise les standards du marché québécois, continue immédiatement. Une boutique imparfaite mais fonctionnelle est préférable à une boutique parfaite jamais terminée.

# ORDRE DES QUESTIONS

Tu poses uniquement la question la plus importante encore inconnue. Ordre de priorité :
1. Secteur exact de l'entreprise
2. Produit ou service principal
3. Prix du produit principal
4. Toute information empêchant réellement une vente

Tout le reste est facultatif.

# CLIENTS VAGUES

Si le client répond "Je ne sais pas", "Comme les autres", "Peu importe", "Fais ce que tu veux" : prends une décision professionnelle, explique-la en une phrase, continue immédiatement. Ne repose jamais la même question.

# CLIENTS QUI DONNENT TROP D'INFORMATIONS

Si plusieurs informations sont fournies dans le même message : analyse tout, récupère tout, ne redemande jamais une info déjà donnée, passe directement à la prochaine info critique.

# DÉTECTION DU SECTEUR

Dès le premier message : identifie le secteur précis. Adapte immédiatement la structure des produits, le vocabulaire, le ton, le thème, la couleur accent, la typographie. Ne mentionne jamais ce processus au client.

# STRUCTURE DES PRODUITS — RÈGLE ABSOLUE

Formats, dimensions, superficies, poids, capacités ou quantités différents avec des prix différents = produits séparés.

✅ Pergola 8x8 = produit | ✅ Pergola 10x10 = produit | ✅ Pergola 12x12 = produit
❌ Un seul produit avec variantes 8x8 / 10x10 / 12x12

Les variantes sont réservées uniquement aux différences esthétiques : couleur, finition, matériau, parfum, texture.
Les demandes personnalisées complexes → questions_client.

# PRODUITS ET SERVICES

NE JAMAIS INVENTER un produit principal qui n'a pas été mentionné par le client. Tu peux reformuler, améliorer les titres/descriptions, suggérer des complémentaires. Jamais ajouter un service principal sans info du client.

# GÉNÉRATION DES PRODUITS

Chaque produit doit avoir : nom vendeur, description courte avec bénéfice, prix, emoji pertinent.
❌ Table en bois → ✅ Table rustique en pin massif
❌ Service de tonte → ✅ Entretien complet de pelouse résidentielle
Génère au moins 3 produits si le secteur le permet.

# PRIX

Si inconnus : estime selon le marché québécois, informe le client, continue immédiatement. Ne jamais laisser un produit sans prix.

# IMAGES

image_url = "" toujours. Ne jamais générer image_url. Ne jamais mentionner Unsplash, images IA, ou toute source d'images. Ne jamais parler des images au client.

# LOGIQUE DE VENTE OBLIGATOIRE

Chaque boutique doit contenir : une proposition de valeur claire, au moins 3 avantages, un appel à l'action, un élément de réassurance (soumission gratuite, satisfaction garantie, fabrication locale, livraison rapide, garantie de qualité).

# SLOGANS ET DESCRIPTIONS

Toujours courts, percutants, crédibles, spécifiques au secteur. Évite les phrases génériques.

# THÈMES DISPONIBLES
- moderne : services généraux, tech, numérique, agences, consultants
- bold : sécurité, nettoyage industriel, déménagement, secteurs robustes
- artisanal : bois, menuiserie, pergolas, meubles, produits faits main, rénovation
- elegant : bijoux, mode haut de gamme, spa, cosmétiques, cadeaux luxe
- nature : produits bio, jardinage, agriculture, miel, sirop d'érable
- construction : construction, excavation, béton, toiture, paysagement, entrepreneur général
- tech : informatique, développement web, électronique, gaming, applications
- cafe : café, boulangerie, pâtisserie, traiteur
- mode : vêtements, accessoires, lifestyle
- sport : gym, entraînement, équipement sportif
- medical : clinique, santé, bien-être, thérapie, massothérapie
- resto : restaurant, bar, brasserie, cuisine du monde
- vintage : antiquités, seconde main, rétro
- minimaliste : coaching, formation, consulting premium
- sombre_pro : automobile, mécanique, tatouage, audiovisuel

# COULEURS ACCENT PAR SECTEUR
- Pergolas / bois / menuiserie → #c27c3a
- Construction / excavation → #e85c1a
- Nature / bio → #2d7a2d
- Alimentation / restauration → #d4401a
- Luxe / bijoux → #b4963c
- Tech / web → #4d8fff
- Santé / bien-être → #1a6fd4
- Mode → #d4547a
- Sport → #ff6b00
- Services généraux → #7c6dfa

# FONTS PAR SECTEUR
- Artisanal, luxe, vintage, restauration → Playfair Display
- Luxe premium, bijoux → Cormorant Garamond
- Nature → Nunito
- Construction, sport → Barlow
- Tech → Space Grotesk
- Café → Lora
- Mode → DM Sans
- Par défaut → Inter

# CHOIX DU THÈME

Tu choisis automatiquement le thème, la couleur accent et la typographie selon ton jugement professionnel. Le client ajustera si nécessaire.

# RÈGLE FINALE

L'action est toujours prioritaire sur la précision. Construis avant de questionner.

# LANGUE

Détecte automatiquement la langue utilisée. Réponds dans la même langue. Adapte-toi immédiatement si elle change.

---

Service: "${service}"

Conversation jusqu'ici:
${history}

---
${userCount >= 4 ? 'Tu as ASSEZ d\'informations. Génère la boutique maintenant. Aucune autre question.' : 'Si une info ESSENTIELLE manque → 1 question courte. Sinon génère directement.'}

# FORMAT DE SORTIE — RÈGLE ABSOLUE

Si tu poses une question:
{"type":"question","message":"ton message naturel avec la question"}

Si tu génères la boutique, réponds UNIQUEMENT avec ce JSON. Aucun texte avant ou après. Aucun backtick:
${template}

# RÈGLES TECHNIQUES CRITIQUES
- prix_base et prix_extra = toujours des NOMBRES (ex: 25), jamais des strings
- prix_extra = 0 et prix_extra_affiche = "" si pas de frais supplémentaires
- image_url = toujours ""
- image_emoji = emoji pertinent pour le produit
- url_slug = 1 mot minuscule sans accent sans espace
- IDs uniques pour chaque produit/variante/option/choix
- variantes = formats/tailles/dimensions avec PRIX DIFFÉRENTS
- options = esthétiques/personnalisation avec même prix de base
- questions_client = pour les demandes complexes non structurées`
    : `You are Simpl's intelligent configuration assistant — a Quebec SaaS platform for online stores and quote forms.

# MISSION
Configure a complete, credible, professional store ready to sell in under 5 minutes. Always prioritize action over information gathering. Build first. Adjust after.

# GOLDEN RULE
One question per message. Never two. Never a list.

# PHILOSOPHY
Each question must bring ESSENTIAL info. Make smart assumptions, announce them in one sentence. Continue automatically without waiting for validation.

# PRODUCT STRUCTURE — ABSOLUTE RULE
Different formats/sizes/weights/dimensions with DIFFERENT prices = SEPARATE PRODUCTS.
✅ Pergola 8x8, Pergola 10x10, Pergola 12x12 = 3 separate products
❌ One "Pergola" product with 8x8/10x10/12x12 variants
Aesthetic variations (color, finish, material) = OPTIONS on the product.

# IMAGES
image_url = "" always. Never generate image_url. Never mention Unsplash or any image source.

# LANGUAGE
Detect automatically. Respond in the same language. Adapt immediately if it changes.

---
Service: "${service}"
Conversation: ${history}
---
${userCount >= 4 ? 'Generate the store now. No more questions.' : 'If ESSENTIAL info missing → 1 short question. Otherwise generate directly.'}

# OUTPUT FORMAT — ABSOLUTE RULE
Question: {"type":"question","message":"your natural message"}
Store: ${template}

# CRITICAL TECHNICAL RULES
- prix_base and prix_extra = always NUMBERS, never strings
- image_url = always ""
- url_slug = 1 lowercase word no accent no space
- unique ids for each product/variant/option/choice
- variantes = sizes/formats with DIFFERENT prices
- options = aesthetic variations same base price
- Generate at least 3 products if sector allows`;

  // Setup SSE streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const stream = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
      temperature: 0.35,
      stream: true
    });

    let fullText = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) {
        fullText += delta;
        res.write(`data: ${JSON.stringify({ chunk: delta })}\n\n`);
      }
    }

    // Parse full response and send final result
    try {
      const parsed = extractJSON(fullText);
      res.write(`data: ${JSON.stringify(parsed)}\n\n`);
    } catch(e) {
      res.write(`data: ${JSON.stringify({ type: 'question', message: fullText.trim() })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch(e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});


// Helper to safely embed JSON in template literals (escapes backticks)
function safeJSON(obj) {
  return JSON.stringify(obj).replace(/`/g, '\\`');
}

app.post('/api/adjust', async (req, res) => {
  const { store, instruction, lang = 'fr' } = req.body;
  const prompt = `Tu modifies UNIQUEMENT ce qui est demandé. Règles: prix_base/prix_extra = NOMBRES. Ne change pas les ids. "sans prix" = prix_extra:0. Boutique: ${safeJSON(store)} Instruction: "${instruction}" Réponds UNIQUEMENT avec le JSON complet modifié.`;
  try {
    const msg = await groq.chat.completions.create({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 3000, temperature: 0.1 });
    res.json(extractJSON(msg.choices[0].message.content));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── STORE ROUTES ───
app.post('/api/store/save', async (req, res) => {
  const { businessName, email, phone, city, accent, store, lang } = req.body;
  if (!businessName || !email || !store) return res.status(400).json({ error: 'Données manquantes' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Courriel invalide' });

  const base = (store.url_slug || businessName).toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 24) || 'store';
  let slug = base; let n = 1;
  while (await getVendor(slug)) { slug = base + n; n++; }

  const token = crypto.randomBytes(16).toString('hex');

  // Lier au compte user si connecté
  let ownerId = null;
  const authToken = req.headers['x-auth-token'];
  if(authToken && authToken.length === 64){
    const user = await db.collection('users').findOne({ token: authToken });
    if(user) ownerId = user._id.toString();
  }

  const vendor = {
    slug, businessName, email: email.toLowerCase(),
    phone: phone || '', city: city || '',
    accent: accent || '#10b981',
    store, lang: lang || 'fr',
    plan: req.body.plan || (store.mode === 'boutique' ? 'boutique' : 'soumission'),
    paid: false,
    status: 'active',
    token, createdAt: new Date().toISOString(),
    orders: [],
    ...(ownerId && { ownerId })
  };
  await saveVendor(vendor);

  // Emails de création
  emailBoutiqueCreee(vendor, slug, token);
  emailAdminNouvelleBoutique(vendor, slug);

  res.json({ slug, token });
});

app.get('/api/store/:slug', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  let v = await getVendor(req.params.slug);
  // Si pas trouvé par slug, chercher par domaine custom
  if(!v){
    const host = req.headers.host || '';
    const cleanHost = host.split(':')[0].toLowerCase().replace(/^www\./, '');
    if(cleanHost && !cleanHost.includes('simplcomerce') && !cleanHost.includes('railway')){
      v = await db.collection('stores').findOne({ customDomain: cleanHost });
    }
  }
  if (!v) return res.status(404).json({ error: 'Not found' });
  const { token, email, _id, ...safe } = v;
  res.json(safe);
});

app.post('/api/store/:slug/order', async (req, res) => {
  const v = await getVendor(req.params.slug);
  if (!v) return res.status(404).json({ error: 'Not found' });
  const b = req.body;
  const order = {
    id: genId(), ...b,
    clientName: b.clientName || b.name || '',
    clientEmail: b.clientEmail || b.email || '',
    clientPhone: b.clientPhone || b.phone || '',
    clientAddress: b.clientAddress || b.address || '',
    status: 'nouveau',
    createdAt: new Date().toISOString()
  };
  v.orders = v.orders || [];
  v.orders.push(order);
  await saveVendor(v);

  // Emails de commande
  emailNouvelleCommande(v, order);
  emailConfirmationClient(order, v);

  res.json({ success: true, orderId: order.id });
});

// ─── DASHBOARD ROUTES ───
app.get('/api/dashboard/:slug/:token', async (req, res) => {
  const v = await getVendor(req.params.slug);
  if (!v || v.token !== req.params.token) return res.status(403).json({ error: 'Accès refusé' });
  const { _id, ...safe } = v;
  res.json(safe);
});

app.put('/api/dashboard/:slug/store', async (req, res) => {
  const v = await authVendor(req, res); if (!v) return;
  v.store = { ...v.store, ...req.body };
  await saveVendor(v);
  res.json({ success: true });
});

app.put('/api/dashboard/:slug/apparence', async (req, res) => {
  const v = await authVendor(req, res); if (!v) return;
  v.store.apparence = { ...(v.store.apparence || {}), ...req.body };
  v.accent = req.body.couleur_accent || v.accent;
  await saveVendor(v);
  res.json({ success: true });
});

app.put('/api/dashboard/:slug/infos', async (req, res) => {
  const v = await authVendor(req, res); if (!v) return;
  const { businessName, phone, city, slogan, description } = req.body;
  if (businessName) v.businessName = businessName;
  if (phone !== undefined) v.phone = phone;
  if (city !== undefined) v.city = city;
  if (slogan !== undefined) v.store.slogan = slogan;
  if (description !== undefined) v.store.description = description;
  await saveVendor(v);
  res.json({ success: true });
});

app.post('/api/dashboard/:slug/produit', async (req, res) => {
  const v = await authVendor(req, res); if (!v) return;
  const prod = { id: 'prod' + genId(), image_url: '', image_emoji: '📦', variantes: [], options: [], ...req.body };
  v.store.produits = v.store.produits || [];
  v.store.produits.push(prod);
  await saveVendor(v);
  res.json({ success: true, produit: prod });
});

app.put('/api/dashboard/:slug/produit/:prodId', async (req, res) => {
  const v = await authVendor(req, res); if (!v) return;
  const idx = (v.store.produits || []).findIndex(p => p.id === req.params.prodId);
  if (idx === -1) return res.status(404).json({ error: 'Produit not found' });
  v.store.produits[idx] = { ...v.store.produits[idx], ...req.body };
  await saveVendor(v);
  res.json({ success: true });
});

app.delete('/api/dashboard/:slug/produit/:prodId', async (req, res) => {
  const v = await authVendor(req, res); if (!v) return;
  v.store.produits = (v.store.produits || []).filter(p => p.id !== req.params.prodId);
  await saveVendor(v);
  res.json({ success: true });
});

app.post('/api/dashboard/:slug/upload/:prodId', async (req, res) => {
  const v = await getVendor(req.params.slug);
  if (!v || v.token !== req.headers['x-token']) return res.status(403).json({ error: 'Accès refusé' });
  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file' });
    let url;
    try {
      if (cloudinary && process.env.CLOUDINARY_CLOUD_NAME) {
        // Upload vers Cloudinary
        const result = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: 'simpl/' + req.params.slug, resource_type: 'image', transformation: [{ quality: 'auto', fetch_format: 'auto' }] },
            (error, result) => error ? reject(error) : resolve(result)
          );
          stream.end(req.file.buffer);
        });
        url = result.secure_url;
      } else {
        // Fallback local si Cloudinary pas configuré
        url = '/uploads/' + req.params.slug + '/' + req.file.originalname;
      }
    } catch(e) {
      console.error('Cloudinary upload error:', e.message);
      return res.status(500).json({ error: 'Erreur upload image' });
    }
    if (req.params.prodId === 'logo') { v.store.apparence = v.store.apparence || {}; v.store.apparence.logo_url = url; }
    else if (req.params.prodId === 'banniere') { v.store.apparence = v.store.apparence || {}; v.store.apparence.banniere_url = url; }
    else {
      const prod = (v.store.produits || []).find(p => p.id === req.params.prodId);
      if (prod) prod.image_url = url;
    }
    await saveVendor(v);
    res.json({ success: true, url });
  });
});

app.put('/api/dashboard/:slug/order/:orderId', async (req, res) => {
  const v = await authVendor(req, res); if (!v) return;
  const order = (v.orders || []).find(o => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const ancienStatut = order.status;
  order.status = req.body.status || order.status;
  order.note = req.body.note !== undefined ? req.body.note : order.note;
  await saveVendor(v);

  // Email changement de statut si différent
  if (req.body.status && req.body.status !== ancienStatut) {
    emailStatutCommande(order, v, req.body.status);
  }

  res.json({ success: true });
});

// ─── IA DU DASHBOARD ───
app.post('/api/dashboard/:slug/ai', async (req, res) => {
  const v = await authVendor(req, res); if (!v) return;
  const { message, conversation = [] } = req.body;

  const produits = (v.store.produits || []).map(p => ({
    id: p.id, nom: p.nom, prix: p.prix_base,
    variantes: (p.variantes || []).map(x => x.nom),
    options: (p.options || []).map(o => o.nom + ': ' + (o.choix || []).map(c => c.nom).join(', '))
  }));

  const topProduits = (() => {
    const counts = {};
    (v.orders || []).forEach(o => (o.items || []).forEach(i => { counts[i.prodNom] = (counts[i.prodNom] || 0) + i.qty; }));
    return Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0,3).map(([n,c]) => `${n} (${c}x)`).join(', ') || 'Aucune commande encore';
  })();

  const history = conversation.map(m => `${m.role === 'user' ? 'Propriétaire' : 'Assistant'}: ${m.content}`).join('\n');

  const prompt = `Tu es l'assistant business intégré de la boutique "${v.businessName}" sur Simpl.

Tu n'es pas un chatbot générique.

Tu es le bras droit du propriétaire.

Tu connais sa boutique, ses produits, ses commandes, ses paramètres et son historique.

Ton objectif est simple : faire gagner du temps. Chaque réponse doit rapprocher le propriétaire d'un résultat concret.

# IDENTITÉ

Tu es un consultant e-commerce senior québécois. Tu parles simplement. Tu tutoies toujours le propriétaire. Tu vas droit au but. Tu n'utilises jamais de remplissage inutile. Tu n'agis jamais comme un assistant généraliste. Tu travailles uniquement pour cette boutique.

# MISSION PRINCIPALE

Aider le propriétaire à gérer sa boutique, améliorer ses ventes, modifier rapidement son catalogue, comprendre ses données, prendre de meilleures décisions, gagner du temps. Ton rôle est d'exécuter et de conseiller. Pas de discuter inutilement.

# PHILOSOPHIE

Si une demande peut être exécutée immédiatement : exécute-la. Ne demande pas la permission. Ne demande pas de confirmation inutile. Le propriétaire est venu pour obtenir un résultat. Pas pour avoir une conversation.

# CE QUE TU PEUX FAIRE

PRODUITS : modifier un produit, modifier un prix, modifier une description, modifier un titre, modifier un badge, modifier des options, modifier des variantes, créer un produit complet, supprimer un produit (confirmation obligatoire).

BOUTIQUE : modifier le slogan, modifier la description, modifier les informations publiques, proposer des améliorations.

BUSINESS : analyser les ventes, analyser les commandes, analyser les produits populaires, identifier les opportunités, identifier les problèmes.

SUPPORT : expliquer n'importe quelle fonctionnalité, guider le propriétaire dans le dashboard, expliquer les statistiques.

# RÈGLE D'EXÉCUTION

Si tu as assez d'information : AGIS. Si une information manque : demande UNE seule question. Jamais deux. Jamais une liste.

# INTERDICTION DE BLOCAGE

Tu ne peux jamais transformer une tâche de 10 secondes en conversation de 10 minutes.

Utilisateur : "Augmente le prix de ma pergola 10x10"
❌ "Quel produit exactement ? Quelle est la nouvelle valeur ? Pourquoi veux-tu changer le prix ?"
✅ "À combien veux-tu la mettre ?"

# CONSEILS BUSINESS

Quand tu analyses les données : utilise les vraies données disponibles, reste concret, reste mesurable, reste actionnable.
❌ "Travaille ton marketing."
✅ "Ton produit A génère 62 % du chiffre d'affaires. Mets-le en vedette sur la page d'accueil."

# STRUCTURE DES PRODUITS

Formats, dimensions, superficies ou capacités différentes avec prix différents = produits séparés. Ne jamais fusionner. Variantes réservées uniquement aux différences esthétiques : couleur, finition, matériau, parfum, texture.

# SUPPRESSION

Toute suppression définitive doit être confirmée. Exemple : "Tu veux supprimer définitivement le produit 'Pergola 10x10' ?" Aucune autre action ne nécessite de confirmation.

# STYLE DE COMMUNICATION

Court. Direct. Professionnel. Québécois. Aucune phrase inutile.

# INTERDICTIONS

Ne jamais dire : Bien sûr, Absolument, Avec plaisir, Certainement, Excellente question, Bonne idée. Ne jamais faire de remplissage. Ne jamais répéter la même recommandation. Ne jamais répéter une explication déjà donnée. Ne jamais mentionner : Unsplash, banques d'images, images IA, image_url, recherche d'images.

# DONNÉES RÉELLES DE LA BOUTIQUE
Propriétaire: ${v.businessName}
Secteur: ${v.service || 'Non spécifié'}
Mode: ${v.store.mode || 'soumission'} | Thème: ${v.store.apparence?.theme || 'moderne'}
Produits actuels (${produits.length}):
${safeJSON(produits)}
Commandes totales: ${(v.orders || []).length}
Top produits: ${topProduits}
Slogan: ${v.store.slogan || 'Aucun'}

# DONNÉES

Ne jamais inventer des commandes, clients, revenus, statistiques, taux de conversion, visites ou données analytiques. Si une donnée n'existe pas : indique-le clairement et fais une recommandation basée uniquement sur les données disponibles.

# PRIORITÉ BUSINESS

Priorise toujours : 1. Augmenter les ventes 2. Augmenter le taux de conversion 3. Augmenter la valeur moyenne des commandes 4. Réduire le temps de gestion 5. Optimiser l'apparence. Les conseils purement esthétiques sont toujours secondaires.

# LANGUE

Détecte automatiquement la langue utilisée. Réponds dans la même langue. Adapte-toi immédiatement si elle change. Ne mentionne jamais ce changement.

# RÈGLES TECHNIQUES ABSOLUES
- Garde TOUS les IDs existants intacts — ne les change JAMAIS
- prix_base et prix_extra = toujours des NOMBRES, jamais des strings
- image_url = toujours "" — jamais autre chose
- Ne supprime jamais sans confirmation explicite

# CONVERSATION
${history}
Propriétaire: ${message}

# FORMAT DE SORTIE — RÈGLE ABSOLUE
Réponds UNIQUEMENT en JSON valide. Aucun texte avant ou après. Aucun backtick. Aucun markdown.

Réponse texte seulement:
{"type":"message","content":"ton message direct"}

Modification de la boutique (slogan, description, mode, etc.):
{"type":"update","store":${safeJSON(v.store)},"message":"ce que t'as changé en 1 phrase"}

Ajout d'un produit:
{"type":"add_product","produit":{"id":"prod${genId()}","nom":"...","prix_base":0,"prix_affiche":"0$","description":"...","image_emoji":"📦","image_url":"","variantes":[],"options":[]},"message":"confirmation 1 phrase"}

Suppression d'un produit:
{"type":"delete_product","produit_id":"id_existant","message":"confirmation 1 phrase"}

IMPORTANT: Pour type "update", inclus le store COMPLET avec TOUTES les modifications appliquées.`;

  try {
    const msg = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 3000,
      temperature: 0.3
    });
    const data = extractJSON(msg.choices[0].message.content);

    const freshV = await getVendor(req.params.slug);
    if (data.type === 'update' && data.store) {
      freshV.store = { ...freshV.store, ...data.store };
      await saveVendor(freshV);
    } else if (data.type === 'add_product' && data.produit) {
      freshV.store.produits = freshV.store.produits || [];
      freshV.store.produits.push(data.produit);
      await saveVendor(freshV);
    } else if (data.type === 'delete_product' && data.produit_id) {
      freshV.store.produits = (freshV.store.produits || []).filter(p => p.id !== data.produit_id);
      await saveVendor(freshV);
    }

    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ─── ADMIN ROUTES ───
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '14416';


app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.json({ success: true, token: Buffer.from(ADMIN_PASSWORD + ':simpl-admin').toString('base64') });
  } else {
    res.status(401).json({ error: 'Mot de passe incorrect' });
  }
});

function adminAuth(req, res) {
  const token = req.headers['x-admin-token'];
  const expected = Buffer.from(ADMIN_PASSWORD + ':simpl-admin').toString('base64');
  if (token !== expected) { res.status(403).json({ error: 'Non autorisé' }); return false; }
  return true;
}

app.get('/api/admin/stats', async (req, res) => {
  if (!adminAuth(req, res)) return;
  try {
    const stores = await db.collection('stores').find({}).toArray();
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const totalStores = stores.length;
    const activeStores = stores.filter(s => s.status !== 'suspended').length;
    const suspendedStores = stores.filter(s => s.status === 'suspended').length;
    const newThisMonth = stores.filter(s => new Date(s.createdAt) >= thisMonth).length;

    // Revenue stats (paid stores)
    const paidStores = stores.filter(s => s.paid === true);
    const unpaidStores = stores.filter(s => s.status !== 'suspended' && !s.paid);
    const mrr = paidStores.reduce((sum, s) => sum + (s.plan === 'boutique' ? 99 : 49), 0);

    // Monthly revenue history (last 6 months)
    const monthlyRevenue = [];
    for (let i = 5; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const monthStores = stores.filter(s => {
        const d = new Date(s.paidAt || s.createdAt);
        return s.paid && d >= start && d < end;
      });
      const rev = monthStores.reduce((sum, s) => sum + (s.plan === 'boutique' ? 99 : 49), 0);
      monthlyRevenue.push({
        month: start.toLocaleDateString('fr-CA', { month: 'short', year: '2-digit' }),
        revenue: rev,
        count: monthStores.length
      });
    }

    // All orders across all stores
    const allOrders = stores.flatMap(s => (s.orders || []).map(o => ({ ...o, storeName: s.businessName, storeSlug: s.slug })));
    const ordersThisMonth = allOrders.filter(o => new Date(o.createdAt) >= thisMonth).length;

    // Recent stores
    const recentStores = stores.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);

    res.json({
      totalStores, activeStores, suspendedStores, newThisMonth,
      mrr, paidCount: paidStores.length, unpaidCount: unpaidStores.length,
      monthlyRevenue, ordersThisMonth, totalOrders: allOrders.length,
      recentStores,
      stores: stores.map(s => ({
        slug: s.slug, businessName: s.businessName, email: s.email,
        phone: s.phone || '', city: s.city || '',
        createdAt: s.createdAt, status: s.status || 'active',
        paid: s.paid || false, paidAt: s.paidAt || null,
        plan: s.plan || 'soumission',
        ordersCount: (s.orders || []).length,
        token: s.token
      }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/store/:slug', async (req, res) => {
  if (!adminAuth(req, res)) return;
  try {
    const { status, paid, plan, paidAt } = req.body;
    const update = {};
    if (status !== undefined) update.status = status;
    if (paid !== undefined) update.paid = paid;
    if (plan !== undefined) update.plan = plan;
    if (paidAt !== undefined) update.paidAt = paidAt;
    await db.collection('stores').updateOne({ slug: req.params.slug }, { $set: update });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/store/:slug', async (req, res) => {
  if (!adminAuth(req, res)) return;
  try {
    await db.collection('stores').deleteOne({ slug: req.params.slug });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── AUTH ───────────────────────────────────────────────────────────────────

app.post('/api/auth/register', loginLimiter, async (req, res) => {
  const { name, email, password } = req.body;
  if(!name || !email || !password) return res.status(400).json({ error: 'Champs manquants.' });
  if(!isValidEmail(email)) return res.status(400).json({ error: 'Courriel invalide.' });
  if(password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (min. 8 caractères).' });
  if(name.length > 100) return res.status(400).json({ error: 'Nom trop long.' });
  const existing = await db.collection('users').findOne({ email: email.toLowerCase() });
  if(existing) return res.status(400).json({ error: 'Ce courriel est déjà utilisé.' });
  const token = genAuthToken();
  const hashedPwd = await hashPassword(password);
  const result = await db.collection('users').insertOne({
    name: sanitize(name, 100),
    email: email.toLowerCase(),
    password: hashedPwd,
    token,
    createdAt: new Date().toISOString()
  });
  const userId = result.insertedId.toString();
  res.json({ success: true, token, userId });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if(!email || !password) return res.status(400).json({ error: 'Champs manquants.' });
  if(!isValidEmail(email)) return res.status(400).json({ error: 'Courriel invalide.' });
  const user = await db.collection('users').findOne({ email: email.toLowerCase() });
  if(!user || !(await verifyPassword(password, user.password))) {
    await new Promise(r => setTimeout(r, 300));
    return res.status(401).json({ error: 'Courriel ou mot de passe incorrect.' });
  }
  // Rotation du token à chaque login
  const newToken = genAuthToken();
  await db.collection('users').updateOne({ _id: user._id }, { $set: { token: newToken, lastLogin: new Date().toISOString() } });
  res.json({ success: true, token: newToken, name: user.name });
});

app.get('/api/auth/boutiques', async (req, res) => {
  const token = req.headers['x-auth-token'];
  if(!token || token.length !== 64) return res.status(401).json({ error: 'Non connecté.' });
  const user = await db.collection('users').findOne({ token });
  if(!user) return res.status(401).json({ error: 'Session invalide.' });
  const userId = user._id.toString();
  // Chercher par ownerId OU email (pour les boutiques créées avant le système de compte)
  const boutiques = await db.collection('stores').find({
    $or: [{ ownerId: userId }, { email: user.email }]
  }).toArray();
  // Dédupliquer
  const seen = new Set();
  const unique = boutiques.filter(b => { const k = b.slug; if(seen.has(k)) return false; seen.add(k); return true; });
  const safe = unique.map(({ password, ...b }) => b);
  res.json({ boutiques: safe, name: user.name, paid: user.paid||false, plan: user.plan||null, subscriptionStatus: user.subscriptionStatus||null });
});

// ─── PAYPAL CONFIG ───────────────────────────────────────────────────────────

const PAYPAL_BASE = process.env.PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

async function getPayPalToken() {
  const creds = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const d = await r.json();
  if(!d.access_token) throw new Error('PayPal auth failed');
  return d.access_token;
}

// ─── PAYPAL CONNECT ───────────────────────────────────────────────────────────

// Sauvegarder l'email PayPal du vendeur
app.put('/api/dashboard/:slug/paypal', async (req, res) => {
  const v = await authVendor(req, res); if(!v) return;
  const { paypalEmail } = req.body;
  if(!paypalEmail || !isValidEmail(paypalEmail)) return res.status(400).json({ error: 'Courriel PayPal invalide' });
  v.paypalEmail = paypalEmail.toLowerCase();
  await saveVendor(v);
  res.json({ success: true });
});

// Retirer l'email PayPal du vendeur
app.delete('/api/dashboard/:slug/paypal', async (req, res) => {
  const v = await authVendor(req, res); if(!v) return;
  v.paypalEmail = null;
  await saveVendor(v);
  res.json({ success: true });
});

// ─── PAYPAL CHECKOUT ──────────────────────────────────────────────────────────

app.post('/api/store/:slug/checkout', async (req, res) => {
  const v = await getVendor(req.params.slug);
  if(!v) return res.status(404).json({ error: 'Boutique introuvable' });
  if(v.store.mode !== 'boutique') return res.status(400).json({ error: 'Paiement non disponible sur ce plan' });
  if(!v.paypalEmail) return res.status(400).json({ error: 'Le vendeur n\'a pas configuré son compte PayPal' });
  if(!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) return res.status(500).json({ error: 'PayPal non configuré' });

  const { items, clientName, clientEmail, clientPhone, notes, address } = req.body;
  if(!items || !items.length) return res.status(400).json({ error: 'Panier vide' });
  if(!clientName || !clientEmail) return res.status(400).json({ error: 'Nom et courriel requis' });

  const baseUrl = process.env.BASE_URL || 'https://simpl-production.up.railway.app';
  const produits = v.store.produits || [];

  // Calculer les items — prix depuis MongoDB, jamais depuis le client
  const orderItems = [];
  let totalCAD = 0;
  for(const item of items){
    const prod = produits.find(p => p.id === item.prodId || p.nom === item.nom);
    if(!prod) continue;
    let prix = prod.prix_base || 0;
    if(item.varianteId && prod.variantes){
      const variante = prod.variantes.find(vr => vr.id === item.varianteId);
      if(variante) prix += variante.prix_extra || 0;
    }
    if(item.options && prod.options){
      for(const [optId, choixId] of Object.entries(item.options || {})){
        const opt = prod.options.find(o => o.id === optId);
        const choix = opt?.choix?.find(c => c.id === choixId);
        if(choix) prix += choix.prix_extra || 0;
      }
    }
    if(prix <= 0) continue;
    const qty = Math.max(1, Math.min(parseInt(item.qty) || 1, 100));
    orderItems.push({ name: prod.nom.slice(0, 127), unit_amount: { currency_code: 'CAD', value: prix.toFixed(2) }, quantity: String(qty) });
    totalCAD += prix * qty;
  }

  if(!orderItems.length) return res.status(400).json({ error: 'Prix invalides' });

  const orderId = genId();
  const order = {
    id: orderId,
    clientName: sanitize(clientName, 200),
    clientEmail: clientEmail.toLowerCase(),
    clientPhone: sanitize(clientPhone || '', 50),
    clientAddress: sanitize(address || '', 500),
    notes: sanitize(notes || '', 1000),
    items,
    total: totalCAD.toFixed(2) + '$',
    createdAt: new Date().toISOString(),
    paymentStatus: 'pending',
    status: 'en_attente_paiement',
  };

  // Sauvegarder la commande en attente AVANT de créer l'ordre PayPal
  v.orders = v.orders || [];
  v.orders.push(order);
  await saveVendor(v);

  try {
    const accessToken = await getPayPalToken();
    const paypalOrder = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: orderId,
          description: `Commande ${v.businessName}`.slice(0, 127),
          payee: { email_address: v.paypalEmail },
          items: orderItems,
          amount: {
            currency_code: 'CAD',
            value: totalCAD.toFixed(2),
            breakdown: { item_total: { currency_code: 'CAD', value: totalCAD.toFixed(2) } }
          }
        }],
        application_context: {
          brand_name: v.businessName.slice(0, 127),
          locale: 'fr-CA',
          landing_page: 'LOGIN',
          user_action: 'PAY_NOW',
          return_url: `${baseUrl}/api/paypal/capture?slug=${v.slug}&orderId=${orderId}`,
          cancel_url: `${baseUrl}/s/${v.slug}?cancelled=1`
        }
      })
    });
    const paypalData = await paypalOrder.json();
    if(!paypalData.id) throw new Error(paypalData.message || 'Erreur PayPal');
    const approveLink = paypalData.links.find(l => l.rel === 'approve');
    if(!approveLink) throw new Error('Lien PayPal introuvable');
    res.json({ url: approveLink.href });
  } catch(e) {
    console.error('PayPal checkout error:', e.message);
    res.status(500).json({ error: 'Erreur PayPal: ' + e.message });
  }
});

// Capture du paiement après retour PayPal
app.get('/api/paypal/capture', async (req, res) => {
  const { slug, orderId, token: paypalToken } = req.query;
  const baseUrl = process.env.BASE_URL || 'https://simpl-production.up.railway.app';
  if(!slug || !orderId || !paypalToken) return res.redirect(`${baseUrl}/s/${slug || ''}?cancelled=1`);
  try {
    const accessToken = await getPayPalToken();
    const capture = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${paypalToken}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
    });
    const captureData = await capture.json();
    if(captureData.status === 'COMPLETED') {
      const v = await getVendor(slug);
      if(v) {
        const order = (v.orders || []).find(o => o.id === orderId);
        if(order && order.paymentStatus === 'pending') {
          order.paymentStatus = 'paid';
          order.status = 'nouveau';
          order.paypalOrderId = paypalToken;
          await saveVendor(v);
          emailNouvelleCommande(v, order);
          emailConfirmationClient(order, v);
        }
      }
      res.redirect(`${baseUrl}/s/${slug}?order=${orderId}&success=1`);
    } else {
      res.redirect(`${baseUrl}/s/${slug}?cancelled=1`);
    }
  } catch(e) {
    console.error('PayPal capture error:', e.message);
    res.redirect(`${baseUrl}/s/${slug}?cancelled=1`);
  }
});


app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/compte', (req, res) => res.sendFile(path.join(__dirname, 'compte.html')));

// ─── STRIPE BILLING ──────────────────────────────────────────────────────────

// Créer une session d'abonnement Simpl
app.post('/api/billing/subscribe', async (req, res) => {
  if(!stripe) return res.status(500).json({ error: 'Stripe non configuré' });
  const authToken = req.headers['x-auth-token'];
  if(!authToken) return res.status(401).json({ error: 'Non connecté' });
  const user = await db.collection('users').findOne({ token: authToken });
  if(!user) return res.status(401).json({ error: 'Session invalide' });
  const { plan, slug } = req.body;
  if(!plan || !STRIPE_PRICES[plan]) return res.status(400).json({ error: 'Plan invalide' });
  const baseUrl = process.env.BASE_URL || 'https://simpl-production.up.railway.app';
  try {
    // Créer ou récupérer le customer Stripe
    let customerId = user.stripeCustomerId;
    if(!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: { userId: user._id.toString() }
      });
      customerId = customer.id;
      await db.collection('users').updateOne({ _id: user._id }, { $set: { stripeCustomerId: customerId } });
    }
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: STRIPE_PRICES[plan], quantity: 1 }],
      mode: 'subscription',
      subscription_data: {
        trial_period_days: 30,
        metadata: { userId: user._id.toString(), slug: slug || '' }
      },
      success_url: `${baseUrl}/compte?billing=success`,
      cancel_url: `${baseUrl}/compte?billing=cancelled`,
      metadata: { userId: user._id.toString(), slug: slug || '', plan }
    });
    res.json({ url: session.url });
  } catch(e) {
    console.error('Billing error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Portail client Stripe — gérer/annuler abonnement
app.post('/api/billing/portal', async (req, res) => {
  if(!stripe) return res.status(500).json({ error: 'Stripe non configuré' });
  const authToken = req.headers['x-auth-token'];
  if(!authToken) return res.status(401).json({ error: 'Non connecté' });
  const user = await db.collection('users').findOne({ token: authToken });
  if(!user || !user.stripeCustomerId) return res.status(400).json({ error: 'Aucun abonnement actif' });
  const baseUrl = process.env.BASE_URL || 'https://simpl-production.up.railway.app';
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${baseUrl}/compte`
    });
    res.json({ url: session.url });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/dashboard/:slug/upgrade-request', async (req, res) => {
  const v = await authVendor(req, res); if (!v) return;
  const { plan, email, businessName } = req.body;
  // Envoie un email à l'admin pour notifier la demande d'upgrade
  try {
    if (resend) {
      await resend.emails.send({
        from: 'no-reply@simplcomerce.com',
        to: 'wtalbot442@gmail.com',
        subject: `⚡ Demande d'upgrade — ${businessName}`,
        html: `<p><strong>${businessName}</strong> (${email}) veut passer au plan <strong>${plan}</strong>.</p><p>Slug: ${v.slug}</p>`
      });
    }
    res.json({ success: true });
  } catch(e) {
    res.json({ success: true }); // On fail silencieusement
  }
});

app.put('/api/dashboard/:slug/custom-domain', async (req, res) => {
  const v = await authVendor(req, res); if(!v) return;
  const { domain } = req.body;
  if(!domain){
    v.customDomain = null;
    await saveVendor(v);
    return res.json({ success: true });
  }
  const cleanDomain = domain.toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '').trim();
  if(!cleanDomain) return res.status(400).json({ error: 'Domaine invalide.' });
  // Vérifier que ce domaine est pas déjà pris
  const existing = await db.collection('stores').findOne({ customDomain: cleanDomain, slug: { $ne: req.params.slug } });
  if(existing) return res.status(400).json({ error: 'Ce domaine est déjà utilisé par une autre boutique.' });
  v.customDomain = cleanDomain;
  await saveVendor(v);
  res.json({ success: true, domain: cleanDomain });
});

app.get('/creer', (req, res) => res.sendFile(path.join(__dirname, 'creer.html')));
// Custom domain — si quelqu'un accède via son propre domaine
app.use(async (req, res, next) => {
  const host = req.headers.host || '';
  // Ignorer les domaines Simpl et localhost
  const simplDomains = ['simplcomerce.com', 'www.simplcomerce.com', 'simpl-production.up.railway.app'];
  const isSimpl = simplDomains.some(d => host.includes(d)) || host.includes('localhost') || host.includes('railway');
  if(isSimpl) return next();
  // Chercher la boutique avec ce domaine custom
  const cleanHost = host.split(':')[0].toLowerCase().replace(/^www\./, '');
  const vendor = await db.collection('stores').findOne({ customDomain: cleanHost });
  if(!vendor) return next();
  // Servir la boutique
  if(req.path === '/' || req.path === '') {
    return res.sendFile(path.join(__dirname, 'store.html'));
  }
  // Passer les requêtes API normalement
  next();
});

app.get('/s/:slug', (req, res) => res.sendFile(path.join(__dirname, 'store.html')));
app.get('/dashboard/:slug/:token', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ─── START ───
const PORT = process.env.PORT || 3000;
connectDB().then(() => {
  app.listen(PORT, () => console.log(`Simpl running on port ${PORT}`));
}).catch(err => {
  console.error('❌ MongoDB connection failed:', err);
  process.exit(1);
});
