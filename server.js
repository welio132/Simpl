const express = require('express');
const cors = require('cors');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const app = express();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || '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' });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));
app.use('/uploads', express.static('uploads'));

const DB_FILE = 'stores.json';

// Multer pour upload de fichiers
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/' + req.params.slug;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, crypto.randomBytes(8).toString('hex') + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

function loadDB() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({}));
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch(e) { return {}; }
}
function saveDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }
function extractJSON(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('No JSON');
  return JSON.parse(text.substring(s, e + 1));
}
function genId() { return crypto.randomBytes(4).toString('hex'); }
function authVendor(req, res) {
  const db = loadDB();
  const v = db[req.params.slug];
  if (!v || v.token !== req.headers['x-token']) { res.status(403).json({ error: 'Accès refusé' }); return null; }
  return { db, v };
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
    "apparence": {"couleur_accent": "#10b981", "logo_url": "", "banniere_url": "", "police": "Inter", "style": "dark"},
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

STRUCTURE DES PRODUITS Formats, tailles, volumes, poids ou dimensions différents = produits distincts, chacun avec son propre prix, sa propre fiche, son propre inventaire et ses propres images. Les variations esthétiques (couleurs, parfums, matériaux, saveurs, essences, modèles, finitions) = options sur le produit. Les demandes complexes (nom personnalisé, texte gravé, couleurs multiples, instructions spéciales, description de projet) = champ texte libre, créé automatiquement.

PRIX Si les prix sont inconnus, estime automatiquement selon le marché québécois, la concurrence moyenne et un positionnement réaliste. Présente-les comme recommandations de départ, jamais comme décisions finales.

ENTREPRISES DE SERVICES Créer automatiquement selon le secteur : soumission rapide, demande d'estimation, demande de rappel, prise de rendez-vous, téléversement de photos si pertinent. Pour construction, rénovation, paysagement, excavation, fabrication ou services techniques : formulaire adapté au secteur généré automatiquement.

GÉNÉRATION AUTOMATIQUE Dès que tu as assez d'informations, arrête de poser des questions et génère tout d'un coup.

GESTION DE L'INCERTITUDE Quand l'information est floue ou manquante : ne bloque jamais, choisis l'option la plus probable, continue sans demander.

INTERDICTIONS Ne jamais poser plusieurs questions. Ne jamais demander une info déjà déductible. Ne jamais attendre une validation intermédiaire. Ne jamais ralentir le processus inutilement.

---

Service: "${service}"

Conversation jusqu'ici:
${history}

---

${userCount >= 4 ? 'Tu as assez d\'informations. Génère la boutique maintenant.' : 'Si une info ESSENTIELLE manque → 1 question courte et naturelle. Sinon génère directement.'}

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
- options = parfums/couleurs/matériaux (même prix de base)
- Si liste donnée → chaque élément devient un choix dans une option`

    : `You are Simpl's intelligent configuration assistant, a SaaS platform for creating online stores and quick quote forms.

MISSION Configure a fully functional store or quote system in under 5 minutes. The goal is not to collect all possible information — it's to quickly launch a credible, complete, sellable store with minimum effort from the entrepreneur. Always prioritize action over information gathering.

ABSOLUTE RULE One question per message. Never two. Never a main question with a sub-question. Never a list.

PHILOSOPHY Each question must bring essential, irreplaceable information. If the information doesn't prevent the store from working, don't ask for it. Prefer generating then correcting rather than asking then waiting.

INTELLIGENT ASSUMPTIONS When you assume something, announce it in one sentence: "I'll go with X to move forward, we adjust if needed." Never wait for confirmation for a non-critical assumption.

PRODUCT STRUCTURE Different formats/sizes/weights = separate products with their own price. Aesthetic variations (colors, scents, materials) = options on the product. Complex customizations = free text field, created automatically.

AUTOMATIC GENERATION As soon as you have enough information, stop asking questions and generate everything at once.

---

Service: "${service}"

Conversation so far:
${history}

---

${userCount >= 4 ? 'Generate the store now.' : 'If ESSENTIAL info missing → 1 short natural question. Otherwise generate directly.'}

OUTPUT FORMAT — ABSOLUTE RULE:

If asking a question:
{"type":"question","message":"your natural message with the question"}

If generating the store, reply ONLY with this valid JSON. No text before or after. No backticks:
${template}

CRITICAL TECHNICAL RULES:
- prix_base and prix_extra = always NUMBERS (e.g. 25), never strings
- If no price extra: prix_extra = 0, prix_extra_affiche = ""
- image_emoji = emoji representing the product
- url_slug = 1 lowercase word no accent no space
- unique ids for each product/variant/option/choice
- variantes = sizes/formats/weights (different prices)
- options = scents/colors/materials (same base price)
- If list given → each item becomes a choice in an option`;

  try {
    const msg = await groq.chat.completions.create({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 3000, temperature: 0.35 });
    res.json(extractJSON(msg.choices[0].message.content));
  } catch(e) { res.status(500).json({ error: e.message }); }
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
app.post('/api/store/save', (req, res) => {
  const { businessName, email, phone, city, accent, store, lang } = req.body;
  if (!businessName || !email || !store) return res.status(400).json({ error: 'Données manquantes' });
  const db = loadDB();
  const base = (store.url_slug || businessName).toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 24) || 'store';
  let slug = base; let n = 1;
  while (db[slug]) { slug = base + n; n++; }
  const token = crypto.randomBytes(16).toString('hex');
  db[slug] = { slug, businessName, email, phone: phone||'', city: city||'', accent: accent||'#10b981', store, lang: lang||'fr', token, createdAt: new Date().toISOString(), orders: [] };
  saveDB(db);
  res.json({ slug, token });
});

app.get('/api/store/:slug', (req, res) => {
  const db = loadDB();
  const v = db[req.params.slug];
  if (!v) return res.status(404).json({ error: 'Not found' });
  const { token, email, ...safe } = v;
  res.json(safe);
});

app.post('/api/store/:slug/order', (req, res) => {
  const db = loadDB();
  const v = db[req.params.slug];
  if (!v) return res.status(404).json({ error: 'Not found' });
  const order = { id: genId(), ...req.body, status: 'nouveau', createdAt: new Date().toISOString() };
  v.orders.push(order);
  saveDB(db);
  res.json({ success: true, orderId: order.id });
});

// ─── DASHBOARD ROUTES (authentifiées) ───
app.get('/api/dashboard/:slug/:token', (req, res) => {
  const db = loadDB();
  const v = db[req.params.slug];
  if (!v || v.token !== req.params.token) return res.status(403).json({ error: 'Accès refusé' });
  res.json(v);
});

// Mettre à jour le store complet
app.put('/api/dashboard/:slug/store', (req, res) => {
  const auth = authVendor(req, res); if (!auth) return;
  const { db, v } = auth;
  v.store = { ...v.store, ...req.body };
  saveDB(db);
  res.json({ success: true });
});

// Mettre à jour l'apparence
app.put('/api/dashboard/:slug/apparence', (req, res) => {
  const auth = authVendor(req, res); if (!auth) return;
  const { db, v } = auth;
  v.store.apparence = { ...(v.store.apparence || {}), ...req.body };
  v.accent = req.body.couleur_accent || v.accent;
  saveDB(db);
  res.json({ success: true });
});

// Mettre à jour les infos du vendeur
app.put('/api/dashboard/:slug/infos', (req, res) => {
  const auth = authVendor(req, res); if (!auth) return;
  const { db, v } = auth;
  const { businessName, phone, city, slogan, description } = req.body;
  if (businessName) v.businessName = businessName;
  if (phone !== undefined) v.phone = phone;
  if (city !== undefined) v.city = city;
  if (slogan !== undefined) v.store.slogan = slogan;
  if (description !== undefined) v.store.description = description;
  saveDB(db);
  res.json({ success: true });
});

// Ajouter un produit
app.post('/api/dashboard/:slug/produit', (req, res) => {
  const auth = authVendor(req, res); if (!auth) return;
  const { db, v } = auth;
  const prod = { id: 'prod' + genId(), image_url: '', image_emoji: '📦', variantes: [], options: [], ...req.body };
  v.store.produits = v.store.produits || [];
  v.store.produits.push(prod);
  saveDB(db);
  res.json({ success: true, produit: prod });
});

// Modifier un produit
app.put('/api/dashboard/:slug/produit/:prodId', (req, res) => {
  const auth = authVendor(req, res); if (!auth) return;
  const { db, v } = auth;
  const idx = (v.store.produits || []).findIndex(p => p.id === req.params.prodId);
  if (idx === -1) return res.status(404).json({ error: 'Produit not found' });
  v.store.produits[idx] = { ...v.store.produits[idx], ...req.body };
  saveDB(db);
  res.json({ success: true });
});

// Supprimer un produit
app.delete('/api/dashboard/:slug/produit/:prodId', (req, res) => {
  const auth = authVendor(req, res); if (!auth) return;
  const { db, v } = auth;
  v.store.produits = (v.store.produits || []).filter(p => p.id !== req.params.prodId);
  saveDB(db);
  res.json({ success: true });
});

// Upload image produit
app.post('/api/dashboard/:slug/upload/:prodId', (req, res) => {
  const db = loadDB();
  const v = db[req.params.slug];
  if (!v || v.token !== req.headers['x-token']) return res.status(403).json({ error: 'Accès refusé' });
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const url = '/uploads/' + req.params.slug + '/' + req.file.filename;
    if (req.params.prodId === 'logo') { v.store.apparence = v.store.apparence || {}; v.store.apparence.logo_url = url; }
    else if (req.params.prodId === 'banniere') { v.store.apparence = v.store.apparence || {}; v.store.apparence.banniere_url = url; }
    else {
      const prod = (v.store.produits || []).find(p => p.id === req.params.prodId);
      if (prod) prod.image_url = url;
    }
    saveDB(db);
    res.json({ success: true, url });
  });
});

// Mettre à jour le statut d'une commande
app.put('/api/dashboard/:slug/order/:orderId', (req, res) => {
  const auth = authVendor(req, res); if (!auth) return;
  const { db, v } = auth;
  const order = v.orders.find(o => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.status = req.body.status || order.status;
  order.note = req.body.note !== undefined ? req.body.note : order.note;
  saveDB(db);
  res.json({ success: true });
});

// ─── PAGE ROUTES ───
app.get('/s/:slug', (req, res) => res.sendFile(path.join(__dirname, 'store.html')));
app.get('/dashboard/:slug/:token', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

app.listen(3000, () => console.log('Simpl running on http://localhost:3000'));
