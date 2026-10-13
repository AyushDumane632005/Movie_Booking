# Daverse Cinemas

A React and Express movie discovery and booking app. Browse films, choose a showtime, select seats, save titles, manage bookings, and leave reviews. The customer and admin experiences use Daverse Cinemas branding.

PostgreSQL is the primary store for customer accounts, bookings, and saved films. If PostgreSQL is unavailable but MongoDB is connected, those account records and bookings persist in MongoDB instead (`MONGODB_DB`, default `reelgood`). Registration stores a salted scrypt password hash, and sign-in uses a signed, seven-day, HttpOnly session cookie. Bookings and saved films are attached to the authenticated account. Customers can see only their own booking history and saved list.

## Polyglot data architecture

- **PostgreSQL** is the preferred store for accounts, bookings, and seat reservations. A relational database provides transactions, constraints, and the consistency needed to prevent duplicate reservations.
- **MongoDB** stores movie catalog documents and customer reviews, whose metadata and review content can evolve independently.
- **Redis** caches the movie catalog for five minutes. It is an optimization; the API continues to work if Redis is offline.

The API seeds a small starter film catalog in MongoDB. If PostgreSQL is offline, account and booking data use MongoDB and remain persistent. The store is chosen once at startup and stays consistent across restarts; `ACCOUNT_STORE=postgres` or `ACCOUNT_STORE=mongodb` can pin it explicitly. If MongoDB is offline, movie browsing uses the bundled catalog. Reviews require MongoDB.

## Run locally

1. Install Node.js and Docker Desktop.
2. Copy `.env.example` to `.env`.
3. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` to your own credentials. Replace `JWT_SECRET` with a unique random secret of at least 32 bytes. Do not commit `.env`.
4. Start the databases with `docker compose up -d`.
5. Install packages with `npm ci`.
6. Start the app with `npm run dev`.
7. Open `http://localhost:5173`.

The API listens on port 4000. The frontend proxies `/api` requests to it.

## Deploy the frontend and API

GitHub Pages hosts only the static frontend. It does not run this Express API or the PostgreSQL, MongoDB, and Redis services. The included `render.yaml` is a Render Blueprint for the API; create a Blueprint from the GitHub repository and provide the prompted database connection strings, `CLIENT_ORIGIN` (the exact frontend origin, without a trailing slash), and strong admin credentials. Render generates the `JWT_SECRET`. Redis is optional. If you deploy the API elsewhere, configure the equivalent environment variables from `.env.example`.

To deploy the frontend, push this repository to GitHub and add a repository variable named `VITE_API_URL` containing the backend's public HTTPS origin, for example `https://api.example.com` (no `/api` suffix). In **Settings → Pages**, select **GitHub Actions** as the build and deployment source. The workflow in `.github/workflows/pages.yml` builds the Vite app for either a user site or a repository subpath and deploys it. The first deployment starts automatically when you push to `main` or `master`; you can also run it from the Actions tab. The build fails with a clear message if `VITE_API_URL` is missing or does not use HTTPS.

The frontend and API must use HTTPS. Production login uses secure cross-origin cookies. Browser privacy settings may block cookies when the Pages site and API use unrelated domains; for reliable sign-in, use a custom domain for Pages and a sibling API subdomain (for example, `cinema.example.com` and `api.example.com`), and set `CLIENT_ORIGIN` to the Pages domain.

## Admin portal

Open `http://localhost:5173/admin` and sign in with the `ADMIN_USERNAME` and `ADMIN_PASSWORD` configured in your local `.env`. The dashboard reports booking counts and ticket counts per movie, each reservation's date and showtime, customer and seat details, ticket sales, and the latest 50 bookings. Admin access uses a separate signed HttpOnly session cookie.

## API

- `GET /api/health`
- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- `GET /api/account/bookings`, `PUT /api/account/favorites/:movieId` (signed in)
- `POST/GET /api/admin/session`, `POST /api/admin/logout`, `GET /api/admin/metrics` (admin session required)
- `GET /api/movies`, `GET /api/movies/:id`
- `GET /api/shows/:movieId/:date`
- `GET /api/seats/:movieId/:date/:time`
- `POST /api/bookings`
- `GET/POST /api/movies/:id/reviews`

The demo uses a fixed ticket price. Payment processing, email verification, and password reset are not configured. Before public deployment, connect a payment provider and transactional email service, configure HTTPS and production secrets, and review the booking policy for cancellations and refunds. Seat holds and reservations are checked under a PostgreSQL transaction.
