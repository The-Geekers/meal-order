'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'distillerie';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-session-secret';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'repas.sqlite'));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS meals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','closed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  opened_at TEXT,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS meal_people (
  meal_id INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL,
  person_token TEXT NOT NULL,
  person_name TEXT NOT NULL,
  UNIQUE(meal_id, person_id)
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meal_id INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  max_choices INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meal_id INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL,
  person_token TEXT NOT NULL,
  person_name TEXT NOT NULL,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  distributed_at TEXT,
  UNIQUE(meal_id, person_id)
);
CREATE TABLE IF NOT EXISTS order_items (
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (order_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_categories_meal ON categories(meal_id);
CREATE INDEX IF NOT EXISTS idx_orders_meal ON orders(meal_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
`);

function tableColumns(name) {
  return db.prepare(`PRAGMA table_info(${name})`).all().map(r => r.name);
}
function migratePersonSnapshots() {
  const mealPeopleOk = tableColumns('meal_people').includes('person_token');
  const ordersOk = tableColumns('orders').includes('person_token');
  if (mealPeopleOk && ordersOk) return;
  console.log('[DB] Migration historique personnes vers snapshots...');
  db.exec('PRAGMA foreign_keys=OFF;');
  try {
    db.exec('BEGIN;');
    db.exec(`
      CREATE TABLE meal_people_v2 (
        meal_id INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
        person_id INTEGER NOT NULL,
        person_token TEXT NOT NULL,
        person_name TEXT NOT NULL,
        UNIQUE(meal_id, person_id)
      );
      INSERT INTO meal_people_v2(meal_id,person_id,person_token,person_name)
      SELECT mp.meal_id,mp.person_id,p.token,p.name FROM meal_people mp JOIN people p ON p.id=mp.person_id;
      CREATE TABLE orders_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meal_id INTEGER NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
        person_id INTEGER NOT NULL,
        person_token TEXT NOT NULL,
        person_name TEXT NOT NULL,
        submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        distributed_at TEXT,
        UNIQUE(meal_id, person_id)
      );
      INSERT INTO orders_v2(id,meal_id,person_id,person_token,person_name,submitted_at,updated_at,distributed_at)
      SELECT o.id,o.meal_id,o.person_id,p.token,p.name,o.submitted_at,o.updated_at,o.distributed_at FROM orders o JOIN people p ON p.id=o.person_id;
      DROP TABLE meal_people;
      DROP TABLE orders;
      ALTER TABLE meal_people_v2 RENAME TO meal_people;
      ALTER TABLE orders_v2 RENAME TO orders;
      CREATE INDEX IF NOT EXISTS idx_orders_meal ON orders(meal_id);
      COMMIT;
    `);
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys=ON;');
  }
  const issues = db.prepare('PRAGMA foreign_key_check').all();
  if (issues.length) throw new Error(`Migration SQLite invalide: ${JSON.stringify(issues)}`);
}
migratePersonSnapshots();
db.prepare('UPDATE categories SET max_choices=1 WHERE max_choices<>1').run();

const MENU_PRESETS = ['Entrée','Plat','Accompagnement','Dessert','Boisson fraîche','Boisson chaude'];

const app = express();
const server = http.createServer(app);
const io = new Server(server, { transports: ['websocket', 'polling'] });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 12 * 60 * 60 * 1000 }
}));

const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

function token() { return crypto.randomBytes(9).toString('base64url'); }
function safeEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function adminOnly(req, res, next) { if (req.session.admin) return next(); return res.redirect('/admin/login'); }
function int(v) { const n = Number(v); return Number.isInteger(n) ? n : null; }
function getMeal(id) { return db.prepare('SELECT * FROM meals WHERE id=?').get(id); }
function currentMeal() { return db.prepare("SELECT * FROM meals ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, id DESC LIMIT 1").get(); }
function activeOpenMealForPerson(personId) {
  return db.prepare(`SELECT m.* FROM meals m JOIN meal_people mp ON mp.meal_id=m.id WHERE mp.person_id=? AND m.status='open' ORDER BY m.id DESC LIMIT 1`).get(personId);
}
function mealCategories(mealId) {
  const cats = db.prepare('SELECT * FROM categories WHERE meal_id=? ORDER BY sort_order,id').all(mealId);
  const itemStmt = db.prepare('SELECT * FROM items WHERE category_id=? AND active=1 ORDER BY sort_order,id');
  return cats.map(c => ({ ...c, items: itemStmt.all(c.id) }));
}
function mealPeople(mealId) {
  return db.prepare(`SELECT mp.person_id id, COALESCE(p.name,mp.person_name) name, mp.person_token token,
    COALESCE(p.active,0) active, o.id order_id, o.submitted_at, o.updated_at, o.distributed_at
    FROM meal_people mp
    LEFT JOIN people p ON p.id=mp.person_id
    LEFT JOIN orders o ON o.meal_id=mp.meal_id AND o.person_id=mp.person_id
    WHERE mp.meal_id=? ORDER BY name COLLATE NOCASE`).all(mealId);
}
function mealStats(mealId) {
  const total = db.prepare('SELECT COUNT(*) n FROM meal_people WHERE meal_id=?').get(mealId).n;
  const answered = db.prepare('SELECT COUNT(*) n FROM orders WHERE meal_id=?').get(mealId).n;
  const distributed = db.prepare('SELECT COUNT(*) n FROM orders WHERE meal_id=? AND distributed_at IS NOT NULL').get(mealId).n;
  return { total, answered, missing: total - answered, distributed };
}
function aggregate(mealId) {
  return db.prepare(`SELECT c.name category, i.name item, COUNT(*) qty
    FROM order_items oi
    JOIN orders o ON o.id=oi.order_id
    JOIN items i ON i.id=oi.item_id
    JOIN categories c ON c.id=i.category_id
    WHERE o.meal_id=?
    GROUP BY c.id,i.id ORDER BY c.sort_order,c.id,i.sort_order,i.id`).all(mealId);
}
function orderDetails(mealId) {
  const rows = db.prepare(`SELECT o.id order_id,COALESCE(p.name,o.person_name) name,c.name category,i.name item,o.distributed_at
    FROM orders o LEFT JOIN people p ON p.id=o.person_id
    LEFT JOIN order_items oi ON oi.order_id=o.id
    LEFT JOIN items i ON i.id=oi.item_id
    LEFT JOIN categories c ON c.id=i.category_id
    WHERE o.meal_id=? ORDER BY name COLLATE NOCASE,c.sort_order,c.id,i.sort_order,i.id`).all(mealId);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.order_id)) map.set(r.order_id, { order_id: r.order_id, name: r.name, distributed_at: r.distributed_at, choices: [] });
    if (r.item) map.get(r.order_id).choices.push({ category: r.category, item: r.item });
  }
  return [...map.values()];
}
function renderLocals(req, extra={}) { return { title: 'Commandes repas', admin: !!req.session.admin, ...extra }; }
function broadcast(mealId) {
  const people = mealPeople(mealId);
  io.to(`meal:${mealId}`).emit('meal:update', {
    mealId,
    stats: mealStats(mealId),
    aggregate: aggregate(mealId),
    missingPeople: people.filter(p => !p.order_id).map(p => p.name),
    orders: orderDetails(mealId)
  });
}

io.on('connection', socket => {
  socket.on('meal:watch', mealId => { const id = int(mealId); if (id) socket.join(`meal:${id}`); });
});

app.get('/', (req,res) => res.redirect('/order'));
app.get('/health', (req,res) => res.json({ ok:true, version:'0.2.0' }));

app.get('/order', (req,res) => {
  const meal = db.prepare("SELECT * FROM meals WHERE status='open' ORDER BY id DESC LIMIT 1").get();
  if (!meal) return res.render('order-select', renderLocals(req, { meal:null, people:[] }));
  const people = db.prepare(`SELECT p.* FROM people p JOIN meal_people mp ON mp.person_id=p.id WHERE mp.meal_id=? AND p.active=1 ORDER BY p.name COLLATE NOCASE`).all(meal.id);
  res.render('order-select', renderLocals(req, { meal, people }));
});

app.get('/o/:token', (req,res) => {
  const person = db.prepare('SELECT * FROM people WHERE token=? AND active=1').get(req.params.token);
  if (!person) return res.status(404).render('message', renderLocals(req, { heading:'Lien inconnu', message:'Ce lien de commande n’est pas valide.' }));
  const meal = activeOpenMealForPerson(person.id);
  if (!meal) return res.render('message', renderLocals(req, { heading:`Bonjour ${person.name}`, message:'Aucune commande n’est ouverte pour le moment.' }));
  const categories = mealCategories(meal.id);
  const order = db.prepare('SELECT * FROM orders WHERE meal_id=? AND person_id=?').get(meal.id, person.id);
  const selected = order ? db.prepare('SELECT item_id FROM order_items WHERE order_id=?').all(order.id).map(r=>r.item_id) : [];
  res.render('order', renderLocals(req, { person, meal, categories, selected, saved:req.query.saved==='1' }));
});

app.post('/o/:token', (req,res) => {
  const person = db.prepare('SELECT * FROM people WHERE token=? AND active=1').get(req.params.token);
  if (!person) return res.sendStatus(404);
  const meal = activeOpenMealForPerson(person.id);
  if (!meal) return res.status(409).render('message', renderLocals(req, { heading:'Commandes fermées', message:'Cette commande n’accepte plus de modification.' }));
  const categories = mealCategories(meal.id);
  const chosen = [];
  for (const cat of categories) {
    let values = req.body[`cat_${cat.id}`] ?? [];
    if (!Array.isArray(values)) values = [values];
    const allowed = new Set(cat.items.map(i => String(i.id)));
    const clean = [...new Set(values.map(String).filter(v => allowed.has(v)))];
    if (clean.length > cat.max_choices) return res.status(400).render('message', renderLocals(req, { heading:'Commande invalide', message:`Trop de choix pour ${cat.name}.` }));
    chosen.push(...clean.map(Number));
  }
  db.exec('BEGIN');
  try {
    let order = db.prepare('SELECT * FROM orders WHERE meal_id=? AND person_id=?').get(meal.id, person.id);
    if (!order) {
      const r = db.prepare('INSERT INTO orders(meal_id,person_id,person_token,person_name) VALUES(?,?,?,?)').run(meal.id, person.id, person.token, person.name);
      order = { id: Number(r.lastInsertRowid) };
    } else {
      db.prepare('UPDATE orders SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(order.id);
      db.prepare('DELETE FROM order_items WHERE order_id=?').run(order.id);
    }
    const ins = db.prepare('INSERT INTO order_items(order_id,item_id) VALUES(?,?)');
    for (const itemId of chosen) ins.run(order.id, itemId);
    db.exec('COMMIT');
    broadcast(meal.id);
    res.redirect(`/o/${person.token}?saved=1`);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

app.get('/admin/login', (req,res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.render('login', renderLocals(req, { error:null }));
});
app.post('/admin/login', loginLimiter, (req,res) => {
  if (!safeEqual(req.body.password || '', ADMIN_PASSWORD)) return res.status(401).render('login', renderLocals(req, { error:'Mot de passe incorrect.' }));
  req.session.admin = true; res.redirect('/admin');
});
app.post('/admin/logout', adminOnly, (req,res) => req.session.destroy(() => res.redirect('/admin/login')));

app.get('/admin', adminOnly, (req,res) => {
  const meal = currentMeal();
  const meals = db.prepare('SELECT * FROM meals ORDER BY id DESC LIMIT 12').all();
  res.render('admin-home', renderLocals(req, { meal, meals, stats: meal ? mealStats(meal.id) : null }));
});

app.get('/admin/people', adminOnly, (req,res) => {
  const people = db.prepare('SELECT * FROM people ORDER BY active DESC,name COLLATE NOCASE').all();
  res.render('people', renderLocals(req, { people, baseUrl:PUBLIC_BASE_URL }));
});
app.post('/admin/people', adminOnly, (req,res) => {
  const name = String(req.body.name || '').trim();
  if (name) db.prepare('INSERT INTO people(name,token) VALUES(?,?)').run(name, token());
  res.redirect('/admin/people');
});
app.post('/admin/people/:id/toggle', adminOnly, (req,res) => {
  const id=int(req.params.id); if(id) db.prepare('UPDATE people SET active=1-active WHERE id=?').run(id); res.redirect('/admin/people');
});
app.post('/admin/people/:id/token', adminOnly, (req,res) => {
  const id=int(req.params.id); if(id) db.prepare('UPDATE people SET token=? WHERE id=?').run(token(),id); res.redirect('/admin/people');
});
app.post('/admin/people/:id/delete', adminOnly, (req,res) => {
  const id=int(req.params.id);
  if(!id) return res.sendStatus(400);
  const person=db.prepare('SELECT * FROM people WHERE id=?').get(id);
  if(!person) return res.sendStatus(404);
  if(person.active) return res.status(409).render('message', renderLocals(req, {
    heading:'Désactivation requise',
    message:'Désactive cette personne avant de la supprimer.'
  }));
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM orders WHERE person_id=? AND meal_id IN (SELECT id FROM meals WHERE status<>'closed')`).run(id);
    db.prepare(`DELETE FROM meal_people WHERE person_id=? AND meal_id IN (SELECT id FROM meals WHERE status<>'closed')`).run(id);
    db.prepare('DELETE FROM people WHERE id=?').run(id);
    db.exec('COMMIT');
    res.redirect('/admin/people');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
});

app.get('/admin/meals/new', adminOnly, (req,res) => {
  const people = db.prepare('SELECT * FROM people WHERE active=1 ORDER BY name COLLATE NOCASE').all();
  res.render('meal-new', renderLocals(req, { people, menuPresets:MENU_PRESETS }));
});
app.post('/admin/meals', adminOnly, (req,res) => {
  const title=String(req.body.title||'').trim(); if(!title) return res.redirect('/admin/meals/new');
  const r=db.prepare('INSERT INTO meals(title) VALUES(?)').run(title); const mealId=Number(r.lastInsertRowid);
  let ids=req.body.people??[]; if(!Array.isArray(ids)) ids=[ids];
  const ins=db.prepare(`INSERT OR IGNORE INTO meal_people(meal_id,person_id,person_token,person_name)
    SELECT ?,id,token,name FROM people WHERE id=? AND active=1`);
  for(const v of ids){ const id=int(v); if(id) ins.run(mealId,id); }
  let categories=req.body.categories??[]; if(!Array.isArray(categories)) categories=[categories];
  const allowed=new Set(MENU_PRESETS);
  const insertCategory=db.prepare('INSERT INTO categories(meal_id,name,max_choices,sort_order) VALUES(?,?,1,?)');
  let sort=0;
  for(const raw of categories){ const name=String(raw); if(allowed.has(name)) insertCategory.run(mealId,name,sort++); }
  res.redirect(`/admin/meals/${mealId}/edit`);
});

app.get('/admin/meals/:id/edit', adminOnly, (req,res) => {
  const meal=getMeal(int(req.params.id)); if(!meal) return res.sendStatus(404);
  const categories=mealCategories(meal.id);
  const allPeople=db.prepare('SELECT * FROM people WHERE active=1 ORDER BY name COLLATE NOCASE').all();
  const assigned=new Set(db.prepare('SELECT person_id FROM meal_people WHERE meal_id=?').all(meal.id).map(r=>r.person_id));
  res.render('meal-edit', renderLocals(req, { meal,categories,allPeople,assigned }));
});
app.post('/admin/meals/:id/people', adminOnly, (req,res) => {
  const mealId=int(req.params.id); const meal=getMeal(mealId); if(!meal || meal.status!=='draft') return res.redirect(`/admin/meals/${mealId}/edit`);
  let ids=req.body.people??[]; if(!Array.isArray(ids)) ids=[ids];
  db.prepare('DELETE FROM meal_people WHERE meal_id=?').run(mealId);
  const ins=db.prepare(`INSERT OR IGNORE INTO meal_people(meal_id,person_id,person_token,person_name)
    SELECT ?,id,token,name FROM people WHERE id=? AND active=1`);
  for(const v of ids){const id=int(v);if(id)ins.run(mealId,id);} res.redirect(`/admin/meals/${mealId}/edit`);
});
app.post('/admin/meals/:id/categories', adminOnly, (req,res) => {
  const mealId=int(req.params.id); const meal=getMeal(mealId); if(!meal || meal.status!=='draft') return res.redirect(`/admin/meals/${mealId}/edit`);
  const name=String(req.body.name||'').trim();
  if(name){const n=db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 n FROM categories WHERE meal_id=?').get(mealId).n; db.prepare('INSERT INTO categories(meal_id,name,max_choices,sort_order) VALUES(?,?,1,?)').run(mealId,name,n);}
  res.redirect(`/admin/meals/${mealId}/edit`);
});
app.post('/admin/categories/:id/items', adminOnly, (req,res) => {
  const categoryId=int(req.params.id); const cat=db.prepare('SELECT * FROM categories WHERE id=?').get(categoryId); if(!cat) return res.sendStatus(404);
  const meal=getMeal(cat.meal_id); const name=String(req.body.name||'').trim();
  if(meal.status==='draft'&&name){const n=db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 n FROM items WHERE category_id=?').get(categoryId).n; db.prepare('INSERT INTO items(category_id,name,sort_order) VALUES(?,?,?)').run(categoryId,name,n);}
  res.redirect(`/admin/meals/${cat.meal_id}/edit`);
});
app.post('/admin/categories/:id/delete', adminOnly, (req,res) => {
  const categoryId=int(req.params.id); const cat=db.prepare('SELECT * FROM categories WHERE id=?').get(categoryId); if(!cat) return res.sendStatus(404);
  if(getMeal(cat.meal_id).status==='draft') db.prepare('DELETE FROM categories WHERE id=?').run(categoryId);
  res.redirect(`/admin/meals/${cat.meal_id}/edit`);
});
app.post('/admin/items/:id/delete', adminOnly, (req,res) => {
  const itemId=int(req.params.id); const row=db.prepare('SELECT i.*,c.meal_id FROM items i JOIN categories c ON c.id=i.category_id WHERE i.id=?').get(itemId); if(!row) return res.sendStatus(404);
  if(getMeal(row.meal_id).status==='draft') db.prepare('DELETE FROM items WHERE id=?').run(itemId);
  res.redirect(`/admin/meals/${row.meal_id}/edit`);
});
app.post('/admin/meals/:id/status', adminOnly, (req,res) => {
  const mealId=int(req.params.id); const meal=getMeal(mealId); if(!meal) return res.sendStatus(404);
  const status=String(req.body.status||'');
  if(status==='open') {
    db.prepare("UPDATE meals SET status='closed',closed_at=CURRENT_TIMESTAMP WHERE status='open' AND id<>?").run(mealId);
    db.prepare("UPDATE meals SET status='open',opened_at=CURRENT_TIMESTAMP,closed_at=NULL WHERE id=?").run(mealId);
  } else if(status==='closed') db.prepare("UPDATE meals SET status='closed',closed_at=CURRENT_TIMESTAMP WHERE id=?").run(mealId);
  else if(status==='draft' && meal.status!=='open') db.prepare("UPDATE meals SET status='draft',closed_at=NULL WHERE id=?").run(mealId);
  broadcast(mealId); res.redirect(`/admin/meals/${mealId}/recap`);
});

app.get('/admin/meals/:id/recap', adminOnly, async (req,res) => {
  const meal=getMeal(int(req.params.id)); if(!meal) return res.sendStatus(404);
  const people=mealPeople(meal.id); const stats=mealStats(meal.id); const agg=aggregate(meal.id); const orders=orderDetails(meal.id);
  const grouped = new Map();
  for (const r of agg) { if (!grouped.has(r.category)) grouped.set(r.category, []); grouped.get(r.category).push(`${r.item} × ${r.qty}`); }
  const supplierText = [...grouped.entries()].map(([category, items]) => `${category.toUpperCase()}\n${items.join('\n')}`).join('\n\n') || 'Aucune commande.';
  const generalUrl=`${PUBLIC_BASE_URL}/order`; const qr=await QRCode.toDataURL(generalUrl,{margin:1,width:220});
  res.render('recap', renderLocals(req, { meal,people,stats,agg,orders,generalUrl,qr,supplierText }));
});
app.post('/admin/orders/:id/distributed', adminOnly, (req,res) => {
  const orderId=int(req.params.id); const order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId); if(!order) return res.sendStatus(404);
  db.prepare(`UPDATE orders SET distributed_at=CASE WHEN distributed_at IS NULL THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?`).run(orderId);
  broadcast(order.meal_id); res.redirect(`/admin/meals/${order.meal_id}/recap#distribution`);
});

app.use((req,res)=>res.status(404).render('message',renderLocals(req,{heading:'Page introuvable',message:'Cette page n’existe pas.'})));
app.use((err,req,res,next)=>{console.error(err);res.status(500).render('message',renderLocals(req,{heading:'Erreur serveur',message:'Une erreur est survenue.'}));});

server.listen(PORT,'0.0.0.0',()=>{
  if(ADMIN_PASSWORD==='distillerie') console.warn('[SECURITE] Mot de passe admin par défaut actif. Change ADMIN_PASSWORD avant exposition publique.');
  console.log(`Distillerie Repas v0.2.0 — http://0.0.0.0:${PORT}`);
});
