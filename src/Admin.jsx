import { useCallback, useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowLeft, ArrowRight, Banknote, CalendarDays, Clapperboard, Clock3, Film, LogOut, RefreshCw, ShieldCheck, Ticket, TrendingUp, Users } from 'lucide-react';
import './admin.css';
import { apiUrl, appPath } from './lib/urls.js';

const cash = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(value || 0));
const dateLabel = value => value ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

export default function AdminPage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState('Admin');
  const [password, setPassword] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const loadDashboard = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const response = await fetch(apiUrl('/admin/metrics'), { credentials: 'include' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load dashboard.');
      setData(body);
    } catch (err) {
      if (err.message.includes('session expired')) setAuthenticated(false);
      setError(err.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetch(apiUrl('/admin/session'), { credentials: 'include' }).then(async response => {
      if (!response.ok) return;
      setAuthenticated(true); await loadDashboard();
    }).catch(() => {});
  }, [loadDashboard]);

  async function signIn(event) {
    event.preventDefault(); setError(''); setLoading(true);
    try {
      const response = await fetch(apiUrl('/admin/session'), { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not sign in.');
      setAuthenticated(true); setPassword(''); await loadDashboard();
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function signOut() { await fetch(apiUrl('/admin/logout'), { method: 'POST', credentials: 'include' }).catch(()=>{}); setAuthenticated(false); setData(null); setError(''); }

  if (!authenticated) return <main className="admin-login-page">
    <a href={appPath()} className="admin-back"><ArrowLeft size={15}/> Back to Daverse Cinemas</a>
    <form className="admin-login" onSubmit={signIn}>
      <div className="admin-logo"><Clapperboard size={22}/></div>
      <div className="admin-eyebrow">DAVERSE CINEMAS · ADMIN ACCESS</div>
      <h1>Welcome back<span>.</span></h1>
      <p>Sign in to review film bookings, showtimes, and ticket earnings.</p>
      <label htmlFor="admin-username">Admin username</label>
      <input id="admin-username" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} placeholder="Admin" required autoFocus />
      <label htmlFor="admin-password">Password</label>
      <input id="admin-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter admin password" required />
      {error && <div className="admin-error">{error}</div>}
      <button className="admin-submit" disabled={loading}>{loading ? 'Signing in…' : 'Open dashboard'} <ArrowRight size={16}/></button>
      <div className="admin-secure"><ShieldCheck size={14}/> Protected staff dashboard</div>
    </form>
  </main>;

  const totals = data?.totals || {};
  const movies = data?.byMovie || [];
  const maxMovieEarnings = Math.max(...movies.map(m => Number(m.earnings)), 1);
  return <div className="admin-app">
    <aside className="admin-sidebar">
      <a className="admin-brand" href={appPath()}><img className="admin-brand-logo" src={appPath('daverse-logo.png')} alt="Daverse Cinemas"/></a>
      <div className="admin-side-label">WORKSPACE</div>
      <a className="admin-side-link active" href={appPath('admin')}><TrendingUp size={16}/> Overview</a>
      <a className="admin-side-link" href={appPath()}><Film size={16}/> Movie site <ArrowDownLeft size={13}/></a>
      <div className="admin-side-bottom"><div className="admin-avatar">DC</div><div><b>Daverse Admin</b><small>Administrator</small></div><button onClick={signOut} aria-label="Sign out"><LogOut size={15}/></button></div>
    </aside>
    <main className="admin-main">
      <header className="admin-topbar"><div><span>DAVERSE /</span> Overview</div><div className="admin-top-actions"><span className="admin-live"><i/> Live data</span><button onClick={() => loadDashboard()} disabled={loading}><RefreshCw size={14} className={loading?'spin':''}/> Refresh</button><button className="admin-site-link" onClick={() => { window.location.href = '/'; }}>View movie site <ArrowRight size={13}/></button></div></header>
      <div className="admin-content">
        <div className="admin-heading"><div><div className="admin-eyebrow">YOUR CINEMA, AT A GLANCE</div><h1>Overview<span>.</span></h1><p>Booking performance and ticket earnings across your cinema.</p></div><div className="admin-date"><CalendarDays size={15}/>{new Date().toLocaleDateString('en-US', { weekday:'short', month:'long', day:'numeric', year:'numeric' })}</div></div>
        {error && <div className="admin-alert"><span>{error}</span><button onClick={() => loadDashboard()}>Try again</button></div>}
        <section className="admin-kpis">
          <article><div className="kpi-top"><span>GROSS EARNINGS</span><i><Banknote size={17}/></i></div><strong>{cash(totals.earnings)}</strong><small><TrendingUp size={12}/> Total ticket sales</small></article>
          <article><div className="kpi-top"><span>TOTAL BOOKINGS</span><i><Ticket size={17}/></i></div><strong>{Number(totals.bookings || 0).toLocaleString()}</strong><small><Users size={12}/> Confirmed reservations</small></article>
          <article><div className="kpi-top"><span>TICKETS SOLD</span><i><Clapperboard size={17}/></i></div><strong>{Number(totals.tickets || 0).toLocaleString()}</strong><small><Film size={12}/> Seats booked</small></article>
          <article><div className="kpi-top"><span>AVERAGE BOOKING</span><i><TrendingUp size={17}/></i></div><strong>{cash(Number(totals.bookings) ? Number(totals.earnings) / Number(totals.bookings) : 0)}</strong><small><Banknote size={12}/> Earnings per reservation</small></article>
        </section>
        <section className="admin-panels">
          <article className="admin-panel movie-performance"><div className="panel-heading"><div><h2>Top films</h2><p>Revenue by movie</p></div><Film size={17}/></div>
            {movies.length ? <div className="movie-performance-list">{movies.slice(0,6).map(movie=><div className="performance-row" key={movie.id}><div className="performance-title"><b>{movie.title}</b><span>{movie.bookings} bookings · {movie.tickets} tickets</span></div><div className="performance-bar"><i style={{width:`${Math.max(3, Number(movie.earnings)/maxMovieEarnings*100)}%`}}/></div><strong>{cash(movie.earnings)}</strong></div>)}</div> : <div className="admin-empty"><Film size={21}/><span>Movie earnings will appear once bookings are recorded.</span></div>}
          </article>
          <article className="admin-panel"><div className="panel-heading"><div><h2>Recent bookings</h2><p>Latest reservations</p></div><Clock3 size={17}/></div>
            {data?.recent?.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>BOOKING</th><th>GUEST</th><th>MOVIE & SHOW</th><th>SEATS</th><th>EARNINGS</th></tr></thead><tbody>{data.recent.map(row=><tr key={row.id}><td><b className="booking-code">{row.id}</b><small>{dateLabel(row.created_at)}</small></td><td><b>{row.name}</b><small>{row.email}</small></td><td><b>{row.title}</b><small>{dateLabel(row.date)} · {row.time}</small></td><td><span className="admin-seat-count">{row.seats?.length || 0}</span></td><td className="admin-amount">{cash(row.total)}</td></tr>)}</tbody></table></div> : <div className="admin-empty"><Ticket size={21}/><span>{error ? 'Connect PostgreSQL to load booking records.' : 'No bookings recorded yet.'}</span></div>}
          </article>
        </section>
        <footer className="admin-footer"><span><ShieldCheck size={13}/> Admin data is private to your staff account.</span><span>Daverse reporting</span></footer>
      </div>
    </main>
  </div>;
}
