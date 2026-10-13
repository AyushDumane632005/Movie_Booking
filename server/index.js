import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import { MongoClient } from 'mongodb';
import { createClient } from 'redis';
import { createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { movies } from './catalog.js';

const app = express();
const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map(origin => origin.trim()).filter(Boolean);
app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)), credentials: true }));
app.use(express.json());
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const scrypt = promisify(scryptCallback);
let mongo, redis;
let postgresReady = false;
let mongoReady = false;
let activeAccountStore = null;
const accountStore = () => activeAccountStore;
const mongoDb = () => mongo.db(process.env.MONGODB_DB || 'reelgood');

const passwordDigest = async (password, salt) => scrypt(password, salt, 64);
const makeSession = (userId, role = 'customer') => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Login is not configured. Set JWT_SECRET in .env.');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: userId, role, exp: Math.floor(Date.now() / 1000) + (role === 'admin' ? 60 * 60 * 8 : 60 * 60 * 24 * 7) })).toString('base64url');
  const data = `${header}.${payload}`;
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
};
const cookiePolicy = process.env.NODE_ENV === 'production' ? '; SameSite=None; Secure' : '; SameSite=Lax';
const setSessionCookie = (res, token, name = 'reelgood_session', maxAge = 604800) => res.setHeader('Set-Cookie', `${name}=${token}; HttpOnly${cookiePolicy}; Path=/api; Max-Age=${maxAge}`);
const clearSessionCookie = (res, name = 'reelgood_session') => res.setHeader('Set-Cookie', `${name}=; HttpOnly${cookiePolicy}; Path=/api; Max-Age=0`);
const sessionFromRequest = (req, name = 'reelgood_session') => {
  const bearer = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1);
  return bearer || cookie || '';
};
const verifySession = token => {
  const parts = token.split('.');
  if (parts.length !== 3 || !process.env.JWT_SECRET) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha256', process.env.JWT_SECRET).update(data).digest();
  let actual;
  try { actual = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return payload.sub && payload.exp > Math.floor(Date.now() / 1000) ? payload : null;
  } catch { return null; }
};
const publicUser = row => ({ id: row.id, name: row.name, email: row.email, favorites: row.favorites || [] });

async function connectStores() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, favorites TEXT[] NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), movie_id TEXT NOT NULL, movie_title TEXT NOT NULL, show_date DATE NOT NULL, show_time TEXT NOT NULL, seats TEXT[] NOT NULL, customer_name TEXT NOT NULL, email TEXT NOT NULL, total NUMERIC NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id)');
    await pool.query('CREATE INDEX IF NOT EXISTS bookings_user_created_idx ON bookings(user_id, created_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS bookings_show_idx ON bookings(movie_id, show_date, show_time)');
    postgresReady = true;
    console.log('PostgreSQL ready');
  } catch (e) { console.warn('PostgreSQL unavailable; booking persistence disabled:', e.message); }
  try {
    mongo = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017'); await mongo.connect();
    const db = mongoDb();
    await db.collection('movies').createIndex({ id: 1 }, { unique: true });
    await db.collection('users').createIndex({ email: 1 }, { unique: true });
    await db.collection('bookings').createIndex({ userId: 1, createdAt: -1 });
    await db.collection('seatReservations').createIndex({ movieId: 1, date: 1, time: 1, seat: 1 }, { unique: true });
    await db.collection('movies').bulkWrite(movies.map(m => ({ updateOne: { filter: { id: m.id }, update: { $setOnInsert: m }, upsert: true } })));
    mongoReady = true;
    console.log('MongoDB ready');
  } catch (e) { console.warn('MongoDB unavailable; using bundled catalog:', e.message); mongo = null; }
  if (process.env.ACCOUNT_STORE === 'postgres' && postgresReady) activeAccountStore = 'postgres';
  else if (process.env.ACCOUNT_STORE === 'mongodb' && mongoReady) activeAccountStore = 'mongodb';
  else if (postgresReady && mongoReady) {
    try {
      const pgCounts = await pool.query('SELECT (SELECT COUNT(*) FROM users)::int AS users, (SELECT COUNT(*) FROM bookings WHERE user_id IS NOT NULL)::int AS bookings');
      const [users, bookings] = await Promise.all([mongoDb().collection('users').countDocuments(), mongoDb().collection('bookings').countDocuments()]);
      activeAccountStore = users + bookings > 0 && Number(pgCounts.rows[0].users) + Number(pgCounts.rows[0].bookings) === 0 ? 'mongodb' : 'postgres';
    } catch { activeAccountStore = 'postgres'; }
  } else activeAccountStore = postgresReady ? 'postgres' : mongoReady ? 'mongodb' : null;
  if (activeAccountStore) console.log(`Accounts and bookings using ${activeAccountStore}`);
  try { redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' }); redis.on('error', () => {}); await redis.connect(); console.log('Redis ready'); }
  catch { console.warn('Redis unavailable; caching disabled'); redis = null; }
}
app.get('/api/health', (_req, res) => res.json({ ok: true, stores: { postgres: postgresReady, mongodb: mongoReady, accountsAndBookings: accountStore(), redis: !!redis?.isReady } }));
const requireUser = async (req, res, next) => {
  const payload = verifySession(sessionFromRequest(req));
  if (!payload || payload.role !== 'customer') return res.status(401).json({ error: 'Please sign in to continue.' });
  if (!accountStore()) return res.status(503).json({ error: 'Account storage is offline. Start PostgreSQL or MongoDB and try again.' });
  try {
    const user = accountStore() === 'postgres'
      ? (await pool.query('SELECT id,name,email,favorites FROM users WHERE id=$1', [payload.sub])).rows[0]
      : await mongoDb().collection('users').findOne({ id: payload.sub }, { projection: { _id: 0 } });
    if (!user) return res.status(401).json({ error: 'This account is no longer available. Please sign in again.' });
    req.user = user; next();
  } catch { res.status(503).json({ error: 'Could not verify your account. Try again shortly.' }); }
};
app.post('/api/auth/register', async (req, res) => {
  if (!accountStore()) return res.status(503).json({ error: 'Registration is temporarily unavailable. Start PostgreSQL or MongoDB and try again.' });
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter your name (2–80 characters).' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 10 || password.length > 200) return res.status(400).json({ error: 'Choose a password with at least 10 characters.' });
  if (!process.env.JWT_SECRET) return res.status(503).json({ error: 'Account login is not configured. Set JWT_SECRET in .env.' });
  try {
    const salt = randomBytes(16).toString('hex');
    const hash = (await passwordDigest(password, salt)).toString('hex');
    const id = randomUUID();
    let user;
    if (accountStore() === 'postgres') {
      const { rows } = await pool.query('INSERT INTO users (id,name,email,password_hash,password_salt) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,email,favorites', [id,name,email,hash,salt]);
      user = rows[0];
    } else {
      user = { id, name, email, password_hash: hash, password_salt: salt, favorites: [], createdAt: new Date() };
      await mongoDb().collection('users').insertOne(user);
    }
    setSessionCookie(res, makeSession(id));
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (error.code === '23505' || error.code === 11000) return res.status(409).json({ error: 'An account with that email already exists. Sign in instead.' });
    res.status(500).json({ error: 'Could not create your account. Please try again.' });
  }
});
app.post('/api/auth/login', async (req, res) => {
  if (!accountStore()) return res.status(503).json({ error: 'Sign in is temporarily unavailable. Start PostgreSQL or MongoDB and try again.' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  try {
    const user = accountStore() === 'postgres'
      ? (await pool.query('SELECT id,name,email,password_hash,password_salt,favorites FROM users WHERE email=$1', [email])).rows[0]
      : await mongoDb().collection('users').findOne({ email }, { projection: { _id: 0 } });
    if (!user || !password || password.length > 200) return res.status(401).json({ error: 'Email or password is incorrect.' });
    const candidate = await passwordDigest(password, user.password_salt);
    const stored = Buffer.from(user.password_hash, 'hex');
    if (candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) return res.status(401).json({ error: 'Email or password is incorrect.' });
    setSessionCookie(res, makeSession(user.id));
    res.json({ user: publicUser(user) });
  } catch { res.status(500).json({ error: 'Could not sign in. Please try again.' }); }
});
app.post('/api/auth/logout', (_req, res) => { clearSessionCookie(res); res.json({ ok: true }); });
app.get('/api/auth/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));
app.get('/api/account/bookings', requireUser, async (req, res) => {
  try {
    if (accountStore() === 'mongodb') {
      const rows = await mongoDb().collection('bookings').find({ userId: req.user.id }, { projection: { _id: 0, userId: 0, name: 0, email: 0 } }).sort({ createdAt: -1 }).toArray();
      return res.json(rows);
    }
    const { rows } = await pool.query('SELECT id,movie_id AS "movieId",movie_title AS "movieTitle",show_date AS date,show_time AS time,seats,total,created_at AS "createdAt" FROM bookings WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]);
    res.json(rows);
  } catch { res.status(500).json({ error: 'Could not load your tickets.' }); }
});
app.put('/api/account/favorites/:movieId', requireUser, async (req, res) => {
  const { movieId } = req.params;
  if (!movies.some(movie => movie.id === movieId)) return res.status(404).json({ error: 'Movie not found.' });
  try {
    if (accountStore() === 'mongodb') {
      const users = mongoDb().collection('users');
      const update = req.body?.saved ? { $addToSet: { favorites: movieId } } : { $pull: { favorites: movieId } };
      await users.updateOne({ id: req.user.id }, update);
      const user = await users.findOne({ id: req.user.id }, { projection: { _id: 0, favorites: 1 } });
      return res.json({ favorites: user?.favorites || [] });
    }
    const { rows } = await pool.query('UPDATE users SET favorites=CASE WHEN $2 THEN CASE WHEN $3=ANY(favorites) THEN favorites ELSE array_append(favorites,$3) END ELSE array_remove(favorites,$3) END WHERE id=$1 RETURNING favorites', [req.user.id, Boolean(req.body?.saved), movieId]);
    res.json({ favorites: rows[0]?.favorites || [] });
  } catch { res.status(500).json({ error: 'Could not update your saved films.' }); }
});
const matchesSecret = (candidate = '', configured = '') => {
  const a = Buffer.from(candidate);
  const b = Buffer.from(configured);
  return Boolean(configured && a.length === b.length && timingSafeEqual(a, b));
};
app.post('/api/admin/session', (req, res) => {
  const adminName = process.env.ADMIN_USERNAME || '';
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if (!adminName || !adminPassword || !process.env.JWT_SECRET) return res.status(503).json({ error: 'Admin access is not configured. Set ADMIN_USERNAME, ADMIN_PASSWORD and JWT_SECRET in .env.' });
  if (!matchesSecret(String(req.body?.username || ''), adminName) || !matchesSecret(String(req.body?.password || ''), adminPassword)) return res.status(401).json({ error: 'Username or password is incorrect.' });
  setSessionCookie(res, makeSession(adminName, 'admin'), 'reelgood_admin_session', 60 * 60 * 8);
  res.json({ ok: true, username: adminName });
});
app.get('/api/admin/session', (req, res) => {
  const payload = verifySession(sessionFromRequest(req, 'reelgood_admin_session'));
  payload?.role === 'admin' ? res.json({ ok: true, username: payload.sub }) : res.status(401).json({ error: 'Admin sign-in required.' });
});
app.post('/api/admin/logout', (_req, res) => { clearSessionCookie(res, 'reelgood_admin_session'); res.json({ ok: true }); });
const requireAdmin = (req, res, next) => {
  const payload = verifySession(sessionFromRequest(req, 'reelgood_admin_session'));
  if (payload?.role !== 'admin') return res.status(401).json({ error: 'Admin session expired. Sign in again.' });
  next();
};
app.get('/api/admin/metrics', requireAdmin, async (_req, res) => {
  if (!accountStore()) return res.status(503).json({ error: 'Account storage is offline. Start PostgreSQL or MongoDB to view booking earnings.' });
  try {
    if (accountStore() === 'mongodb') {
      const bookings = mongoDb().collection('bookings');
      const [totals, byMovie, recent] = await Promise.all([
        bookings.aggregate([{ $group: { _id: null, bookings: { $sum: 1 }, earnings: { $sum: '$total' }, tickets: { $sum: { $size: '$seats' } } } }, { $project: { _id: 0 } }]).toArray(),
        bookings.aggregate([{ $group: { _id: '$movieId', title: { $first: '$movieTitle' }, bookings: { $sum: 1 }, earnings: { $sum: '$total' }, tickets: { $sum: { $size: '$seats' } } } }, { $project: { id: '$_id', _id: 0, title: 1, bookings: 1, earnings: 1, tickets: 1 } }, { $sort: { earnings: -1 } }]).toArray(),
        bookings.find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(50).toArray()
      ]);
      return res.json({ totals: totals[0] || { bookings: 0, earnings: 0, tickets: 0 }, byMovie, recent: recent.map(row => ({ id: row.id, title: row.movieTitle, date: row.date, time: row.time, seats: row.seats, name: row.name, email: row.email, total: row.total, created_at: row.createdAt })) });
    }
    const [totals, byMovie, recent] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS bookings, COALESCE(SUM(total),0)::numeric AS earnings, COALESCE(SUM(cardinality(seats)),0)::int AS tickets FROM bookings'),
      pool.query('SELECT movie_id AS id, movie_title AS title, COUNT(*)::int AS bookings, COALESCE(SUM(total),0)::numeric AS earnings, COALESCE(SUM(cardinality(seats)),0)::int AS tickets FROM bookings GROUP BY movie_id,movie_title ORDER BY SUM(total) DESC'),
      pool.query('SELECT id,movie_title AS title,show_date AS date,show_time AS time,seats,customer_name AS name,email,total,created_at FROM bookings ORDER BY created_at DESC LIMIT 50')
    ]);
    res.json({ totals: totals.rows[0], byMovie: byMovie.rows, recent: recent.rows });
  } catch (error) { res.status(500).json({ error: `Could not load dashboard: ${error.message}` }); }
});
app.get('/api/movies', async (_req, res) => {
  try {
    if (redis?.isReady) { const cached = await redis.get('catalog:movies'); if (cached) return res.json(JSON.parse(cached)); }
    const list = mongo ? await mongoDb().collection('movies').find({}, { projection: { _id: 0 } }).toArray() : movies;
    if (redis?.isReady) await redis.setEx('catalog:movies', 300, JSON.stringify(list));
    res.json(list);
  } catch { res.json(movies); }
});
app.get('/api/movies/:id', async (req, res) => {
  const movie = mongo ? await mongoDb().collection('movies').findOne({ id: req.params.id }, { projection: { _id: 0 } }) : movies.find(m => m.id === req.params.id);
  movie ? res.json(movie) : res.status(404).json({ error: 'Movie not found' });
});
app.get('/api/movies/:id/reviews', async (req, res) => {
  if (!mongo) return res.json([]);
  const rows = await mongoDb().collection('reviews').find({ movieId: req.params.id }).sort({ createdAt: -1 }).limit(20).toArray(); res.json(rows);
});
app.get('/api/shows/:movieId/:date', (_req, res) => res.json(['12:30 PM','3:45 PM','6:30 PM','9:15 PM']));
app.get('/api/seats/:movieId/:date/:time', async (req, res) => {
  const taken = new Set();
  try {
    if (accountStore() === 'postgres') {
      const { rows } = await pool.query('SELECT seats FROM bookings WHERE movie_id=$1 AND show_date=$2 AND show_time=$3', [req.params.movieId, req.params.date, decodeURIComponent(req.params.time)]); rows.forEach(r => r.seats.forEach(s => taken.add(s)));
    } else if (mongoReady) {
      const rows = await mongoDb().collection('seatReservations').find({ movieId: req.params.movieId, date: req.params.date, time: decodeURIComponent(req.params.time) }, { projection: { _id: 0, seat: 1 } }).toArray(); rows.forEach(row => taken.add(row.seat));
    }
  } catch {}
  res.json([...taken]);
});
app.post('/api/bookings', requireUser, async (req, res) => {
  const { movieId, date, time, seats } = req.body;
  const movie = movies.find(item => item.id === movieId);
  const validDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && date >= new Date().toISOString().slice(0,10);
  const validTime = ['12:30 PM','3:45 PM','6:30 PM','9:15 PM'].includes(time);
  const validSeats = Array.isArray(seats) && seats.length > 0 && seats.length <= 10 && new Set(seats).size === seats.length && seats.every(seat => /^[A-G](?:[1-9]|10)$/.test(seat) && !/^A(?:4|5|6|7)$/.test(seat));
  if (!movie || !validDate || !validTime || !validSeats) return res.status(400).json({ error: 'Check your movie, date, showtime and seat selection.' });
  const id = `RG-${randomUUID().slice(0, 8).toUpperCase()}`;
  const total = seats.length * 14.5;
  if (accountStore() === 'mongodb') {
    const db = mongoDb();
    const seatRows = seats.map(seat => ({ bookingId: id, movieId, date, time, seat, userId: req.user.id }));
    try {
      await db.collection('seatReservations').insertMany(seatRows);
      const bookingDoc = { id, userId: req.user.id, movieId, movieTitle: movie.title, date, time, seats, name: req.user.name, email: req.user.email, total, createdAt: new Date() };
      await db.collection('bookings').insertOne(bookingDoc);
      return res.status(201).json({ id, movieTitle: movie.title, date, time, seats, name: req.user.name, email: req.user.email, total });
    } catch (error) {
      await db.collection('seatReservations').deleteMany({ bookingId: id }).catch(() => {});
      if (error.code === 11000) return res.status(409).json({ error: 'One or more seats were just booked. Choose different seats.' });
      console.error('MongoDB booking save failed:', error.message);
      return res.status(503).json({ error: 'Booking service is unavailable. Please try again shortly.' });
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${movieId}:${date}:${time}`]);
    const taken = await client.query('SELECT seats FROM bookings WHERE movie_id=$1 AND show_date=$2 AND show_time=$3 AND seats && $4::text[]', [movieId,date,time,seats]);
    if (taken.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'One or more seats were just booked. Choose different seats.' }); }
    await client.query('INSERT INTO bookings (id,user_id,movie_id,movie_title,show_date,show_time,seats,customer_name,email,total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id,req.user.id,movieId,movie.title,date,time,seats,req.user.name,req.user.email,total]);
    await client.query('COMMIT');
    res.status(201).json({ id, movieTitle: movie.title, date, time, seats, name: req.user.name, email: req.user.email, total });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Booking transaction failed:', error.message);
    res.status(503).json({ error: 'Booking service is unavailable. Please try again shortly.' });
  } finally { client.release(); }
});
app.post('/api/movies/:id/reviews', async (req,res) => {
  if (!mongo) return res.status(503).json({ error: 'Reviews are unavailable until MongoDB is started.' });
  const { name, text, rating } = req.body; if (!name || !text || !rating) return res.status(400).json({ error: 'Name, rating and review are required.' });
  const review = { movieId: req.params.id, name, text, rating: Number(rating), createdAt: new Date() }; await mongoDb().collection('reviews').insertOne(review); res.status(201).json(review);
});
const port = process.env.PORT || 4000;
connectStores();
app.listen(port, () => console.log(`Reelgood API listening on ${port}`));
