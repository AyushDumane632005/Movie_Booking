import { useState } from 'react';
import { ArrowLeft, ArrowRight, Clapperboard, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import './auth.css';
import { apiUrl, appPath } from './lib/urls.js';

export default function AuthPage({ mode }) {
  const isRegister = mode === 'register';
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch(apiUrl(`/auth/${isRegister ? 'register' : 'login'}`), {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not sign in. Please try again.');
      const params = new URLSearchParams(window.location.search);
      const requested = params.get('next') || appPath();
      const destination = requested.startsWith(appPath()) && !requested.startsWith('//') ? requested : appPath();
      window.location.assign(destination);
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return <main className="auth-page">
    <a href={appPath()} className="auth-back"><ArrowLeft size={15}/> Back to Daverse Cinemas</a>
    <div className="auth-layout">
      <section className="auth-story">
        <img className="auth-logo" src={appPath('daverse-logo.png')} alt="Daverse Cinemas"/>
        <div className="auth-film-note"><span/><div><b>MAKE IT A MOVIE NIGHT</b><small>Your seats. Your films. All in one place.</small></div></div>
      </section>
      <section className="auth-card">
        <div className="auth-card-mark"><Clapperboard size={19}/></div>
        <div className="auth-eyebrow">DAVERSE CINEMAS · YOUR ACCOUNT</div>
        <h1>{isRegister ? 'Join the show.' : 'Welcome back.'}</h1>
        <p className="auth-description">{isRegister ? 'Create your account to save films and keep every ticket close.' : 'Sign in to find your tickets and saved films.'}</p>
        <div className="auth-switch"><a className={!isRegister ? 'selected' : ''} href={`${appPath('login')}${window.location.search}`}>Sign in</a><a className={isRegister ? 'selected' : ''} href={`${appPath('register')}${window.location.search}`}>Create account</a></div>
        <form className="auth-form" onSubmit={submit}>
          {isRegister && <label>Full name<input autoComplete="name" value={name} onChange={e=>setName(e.target.value)} placeholder="Your name" required minLength={2} maxLength={80}/></label>}
          <label>Email address<input type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" required maxLength={254}/></label>
          <label>Password<span className="auth-password"><input type={showPassword ? 'text' : 'password'} autoComplete={isRegister ? 'new-password' : 'current-password'} value={password} onChange={e=>setPassword(e.target.value)} placeholder={isRegister ? 'At least 10 characters' : 'Enter your password'} required minLength={isRegister ? 10 : 1} maxLength={200}/><button type="button" onClick={()=>setShowPassword(x=>!x)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={15}/> : <Eye size={15}/>}</button></span></label>
          {error&&<div className="auth-error" role="alert">{error}</div>}
          <button className="auth-submit" disabled={busy}>{busy ? 'Please wait…' : isRegister ? 'Create my account' : 'Sign in'} <ArrowRight size={16}/></button>
        </form>
        <div className="auth-privacy"><ShieldCheck size={14}/> Your account details are protected.</div>
      </section>
    </div>
  </main>;
}
