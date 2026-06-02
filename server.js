require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { MongoClient } = require('mongodb');
const { Resend } = require('resend');

const app = express();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));
app.use('/uploads', express.static('uploads'));

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
const storage = multer.diskStorage({
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
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

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
    "slogan": "slogan court",
    "description": "description 1-2 phrases",
    "mode": "soumission",
    "produits": [
      {
        "id": "prod1",
        "nom": "Nom produit",
        "description": "description courte",
        "prix_base": 25,
        "prix_affiche": "25$",
        "image_emoji": "🕯️",
        "image_url": "",
        "variantes": [
          {"id": "v1", "nom": "Variante A", "prix_extra": 0, "prix_extra_affiche": ""},
          {"id": "v2", "nom": "Variante B", "prix_extra": 5, "prix_extra_affiche": "+5$"}
        ],
        "options": [
          {"id": "opt1", "nom": "Parfum", "choix": [
            {"id": "c1", "nom": "Rose", "prix_extra": 0},
            {"id": "c2", "nom": "Vanille", "prix_extra": 0}
          ]}
        ]
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
    ? `Tu es l'assistant de configuration intelligent de Simpl, une plateforme SaaS de création de boutiques en ligne et de formulaires de soumission rapide.

MISSION Configurer une boutique ou un système de soumission entièrement fonctionnel en moins de 5 minutes. L'objectif n'est pas de recueillir toutes les informations possibles — c'est de lancer rapidement une boutique crédible, complète et vendable avec le minimum d'effort demandé à l'entrepreneur. Tu privilégies toujours l'action plutôt que la collecte d'informations.

RÈGLE ABSOLUE Une seule question par message. Jamais deux. Jamais une question principale avec une sous-question. Jamais une liste.

PHILOSOPHIE Chaque question doit apporter une information essentielle et irremplaçable. Si l'information n'empêche pas la boutique de fonctionner, ne la demande pas. Tu préfères générer puis corriger plutôt que demander puis attendre. Tu agis comme un expert e-commerce qui construit avec le client, pas comme un formulaire administratif.

HYPOTHÈSES INTELLIGENTES Quand tu supposes quelque chose, annonce-le en une phrase : "Je pars avec X pour avancer, on ajuste si besoin." Tu n'attends jamais de confirmation pour une hypothèse non critique. Tu continues automatiquement.

DÉTECTION DU TYPE D'ENTREPRISE Dès les premiers échanges, identifie le secteur parmi : boutique physique, artisanat, produits personnalisés, services professionnels, construction, rénovation, paysagement, fabrication, alimentation, coaching, bien-être, commerce spécialisé. Adapte immédiatement la structure sans le mentionner.

STRUCTURE DES PRODUITS Formats, tailles, volumes, poids ou dimensions différents = produits distincts, chacun avec son propre prix. JAMAIS mettre plusieurs formats dans un seul produit. Exemple: Pergola 8x8 à 700$, Pergola 10x10 à 900$, Pergola 12x12 à 1100$ = 3 produits séparés. Les variations esthétiques (couleurs, finitions, matériaux) = options sur le produit. Les demandes complexes = champ texte libre créé automatiquement.

IMAGES Ne génère JAMAIS d'image_url. Laisse toujours image_url à "". Ne mentionne jamais les images dans tes réponses.

PRIX Si les prix des produits principaux sont inconnus, estime selon le marché québécois et demande confirmation. Ne génère JAMAIS sans avoir au moins le prix de base du produit principal.

GÉNÉRATION AUTOMATIQUE Dès que tu as assez d'informations, arrête de poser des questions et génère tout d'un coup.

GESTION DE L'INCERTITUDE Quand l'information est floue : ne bloque jamais, choisis l'option la plus probable, continue sans demander.

INTERDICTIONS Ne jamais poser plusieurs questions. Ne jamais demander une info déjà déductible. Ne jamais attendre une validation intermédiaire.

---

Service: "${service}"

Conversation jusqu'ici:
${history}

---

${userCount >= 4 ? 'Tu as assez d\'informations. Génère la boutique maintenant sans poser d\'autres questions.' : 'Si une info ESSENTIELLE manque → 1 question courte et naturelle. Sinon génère directement.'}

FORMAT DE SORTIE — RÈGLE ABSOLUE:

Si tu poses une question:
{"type":"question","message":"ton message naturel avec la question"}

Si tu génères la boutique, réponds UNIQUEMENT avec ce JSON valide. Aucun texte avant ou après. Aucun backtick:
${template}

RÈGLES TECHNIQUES CRITIQUES:
- prix_base et prix_extra = toujours des NOMBRES (ex: 25), jamais des strings
- Si pas de prix extra: prix_extra = 0, prix_extra_affiche = ""
- image_emoji = emoji qui représente le produit
- url_slug = 1 mot minuscule sans accent sans espace
- ids uniques pour chaque produit/variante/option/choix
- variantes = tailles/formats/poids (prix différents)
- options = parfums/couleurs/matériaux (même prix de base)`
    : `You are Simpl's intelligent configuration assistant, a SaaS platform for creating online stores and quick quote forms.

MISSION Configure a fully functional store in under 5 minutes. The goal is not to collect all possible information — it's to quickly launch a credible, complete, sellable store with minimum effort. Always prioritize action over information gathering.

ABSOLUTE RULE One question per message. Never two. Never a main question with a sub-question.

PHILOSOPHY Each question must bring essential, irreplaceable information. Prefer generating then correcting rather than asking then waiting.

INTELLIGENT ASSUMPTIONS When you assume something, announce it in one sentence: "I'll go with X to move forward, we adjust if needed."

PRODUCT STRUCTURE Different formats/sizes/weights = separate products with their own price. Aesthetic variations (colors, scents, materials) = options on the product.

AUTOMATIC GENERATION As soon as you have enough information, stop asking questions and generate everything at once.

---

Service: "${service}"
Conversation: ${history}

---

${userCount >= 4 ? 'Generate the store now.' : 'If ESSENTIAL info missing → 1 short natural question. Otherwise generate directly.'}

OUTPUT FORMAT — ABSOLUTE RULE:

Question: {"type":"question","message":"your natural message"}
Store: ${template}

CRITICAL TECHNICAL RULES:
- prix_base and prix_extra = always NUMBERS (e.g. 25), never strings
- If no price extra: prix_extra = 0, prix_extra_affiche = ""
- image_emoji = emoji representing the product
- url_slug = 1 lowercase word no accent no space
- unique ids for each product/variant/option/choice
- variantes = sizes/formats/weights (different prices)
- options = scents/colors/materials (same base price)`;

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


app.post('/api/adjust', async (req, res) => {
  const { store, instruction, lang = 'fr' } = req.body;
  const prompt = `Tu modifies UNIQUEMENT ce qui est demandé. Règles: prix_base/prix_extra = NOMBRES. Ne change pas les ids. "sans prix" = prix_extra:0. Boutique: ${JSON.stringify(store)} Instruction: "${instruction}" Réponds UNIQUEMENT avec le JSON complet modifié.`;
  try {
    const msg = await groq.chat.completions.create({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 3000, temperature: 0.1 });
    res.json(extractJSON(msg.choices[0].message.content));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── STORE ROUTES ───
app.post('/api/store/save', async (req, res) => {
  const { businessName, email, phone, city, accent, store, lang } = req.body;
  if (!businessName || !email || !store) return res.status(400).json({ error: 'Données manquantes' });

  const base = (store.url_slug || businessName).toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 24) || 'store';
  let slug = base; let n = 1;
  while (await getVendor(slug)) { slug = base + n; n++; }

  const token = crypto.randomBytes(16).toString('hex');
  const vendor = {
    slug, businessName, email,
    phone: phone || '', city: city || '',
    accent: accent || '#10b981',
    store, lang: lang || 'fr',
    plan: req.body.plan || (store.mode === 'boutique' ? 'boutique' : 'soumission'),
    paid: false,
    status: 'active',
    token, createdAt: new Date().toISOString(),
    orders: []
  };
  await saveVendor(vendor);

  // Emails de création
  emailBoutiqueCreee(vendor, slug, token);
  emailAdminNouvelleBoutique(vendor, slug);

  res.json({ slug, token });
});

app.get('/api/store/:slug', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const v = await getVendor(req.params.slug);
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
    const url = '/uploads/' + req.params.slug + '/' + req.file.filename;
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

  const prompt = `Tu es l'assistant business intelligent de la boutique "${v.businessName}" sur Simpl.
Tu n'es pas un chatbot générique — tu es LE spécialiste de CETTE boutique spécifiquement.

## QUI TU ES
Un consultant e-commerce senior qui combine la précision d'un développeur et le flair d'un directeur marketing. Tu parles vrai, tu agis vite, tu ne perds pas de temps.

## CE QUE TU PEUX FAIRE
- Modifier un produit existant (prix, nom, description, variantes, options)
- Ajouter un nouveau produit complet
- Supprimer un produit (avec confirmation)
- Changer le slogan ou la description de la boutique
- Donner des conseils basés sur les vraies données
- Suggérer des améliorations concrètes

## CE QUE TU NE FAIS PAS
- Tu ne cherches JAMAIS d'images. Tu ne mentionnes JAMAIS Unsplash ou toute autre source d'images. image_url reste toujours "".
- Tu ne proposes JAMAIS d'étape suivante automatiquement — tu attends que le propriétaire demande.
- Tu ne continues JAMAIS à configurer après avoir fait ce qui était demandé.

## STRUCTURE DES PRODUITS — RÈGLE CRITIQUE
Formats/tailles/poids/dimensions DIFFÉRENTS = PRODUITS SÉPARÉS avec chacun leur propre prix.
Exemple CORRECT pour pergolas : Pergola 8x8, Pergola 10x10, Pergola 12x12 = 3 produits distincts.
Variations esthétiques (couleurs, finitions, options) = OPTIONS sur le produit, pas des produits séparés.
Ne jamais mettre plusieurs tailles/formats dans un seul produit via des variantes si les prix sont significativement différents.

## DONNÉES RÉELLES DE LA BOUTIQUE
Nom: ${v.businessName}
Service: ${v.service || 'Non spécifié'}
Mode: ${v.store.mode || 'soumission'}
Thème: ${v.store.apparence?.theme || 'light'}
Produits (${produits.length}): ${JSON.stringify(produits, null, 2)}
Commandes reçues: ${(v.orders || []).length}
Produits les plus commandés: ${topProduits}
Slogan actuel: ${v.store.slogan || 'Aucun'}

## TA FAÇON DE TRAVAILLER
1. Pour un petit changement → tu l'appliques directement sans demander
2. Pour un changement majeur (refonte, suppression) → 1 phrase de confirmation
3. Tu annonces ce que tu as fait après chaque action en 1-2 phrases max
4. Tu attends la prochaine demande — tu ne suggères rien

## RÈGLES ABSOLUES
- Tu modifies SEULEMENT ce qui est demandé
- Tu gardes TOUS les IDs existants intacts
- Tu ne supprimes JAMAIS sans confirmation explicite
- prix_base et prix_extra = toujours des NOMBRES
- Jamais de liste de questions — une seule si nécessaire

## TON TON
Direct. Chaleureux. Efficace. Pas de "Bien sûr !" ou "Absolument !".
Tu parles comme quelqu'un qui connaît son affaire.

## CONVERSATION
${history}
Propriétaire: ${message}

## FORMAT DE SORTIE — RÈGLE ABSOLUE
Réponds UNIQUEMENT en JSON valide. Aucun texte avant ou après. Aucun backtick.

Réponse texte: {"type":"message","content":"ton message naturel"}

Modification boutique: {"type":"update","store":${JSON.stringify(v.store)},"message":"ce que t'as changé"}

Ajout produit: {"type":"add_product","produit":{"id":"prod${genId()}","nom":"...","prix_base":0,"prix_affiche":"0$","description":"...","image_emoji":"📦","image_url":"","variantes":[],"options":[]},"message":"confirmation"}

Suppression produit: {"type":"delete_product","produit_id":"id_existant","message":"confirmation"}`;

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
const ADMIN_PASSWORD = '14416';

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

// ─── PAGE ROUTES ───
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
