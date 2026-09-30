# Fuel by Buzah — Meal Prep Manager

A browser app for running a small weekly meal-prep business. It covers taking orders, tracking each customer's macros, building Saturday's shopping list, planning Sunday's deliveries and printing invoices.

Built with **vanilla HTML, CSS and JavaScript** on the front end and **Supabase** (Postgres, Auth, Realtime) for cloud sync. There is no framework and no build step. It deploys free on GitHub Pages.

![Dashboard](docs/screenshot-dashboard.png)

## Why I built it

I'm starting **Fuel by Buzah**, a meal-prep service for busy people who want fitness-friendly food instead of fast food. The business runs on a weekly cycle:

| Day | What happens |
|---|---|
| Mon – Thu | Orders are open |
| Friday | Late orders: either accepted with a premium fee or pushed to next week (configurable) |
| Saturday | Shop and prep |
| Sunday | Cook and deliver or hand off pickups |

Spreadsheets got messy fast, so I built a tool that follows this cycle directly.

## Features

- **Weekly order management.** Every order is assigned to the correct delivery week based on the day it was placed. Friday late fees are applied automatically.
- **Live pricing.** The app handles the delivery fee, a percent discount for pickup, optional sales tax (applied to food only) and late fees.
- **Invoices.** Each order produces a clean invoice that you can print or save as a PDF.
- **Macros built in.** Every meal stores calories, protein, carbs and fat. Each customer card shows how much of their daily targets the week's meals cover.
- **Saturday prep.** Shows a cook list (how many of each meal to make) and a shopping list. The shopping list combines ingredients across all orders, e.g. *jasmine rice: 20 cup, used in 2 meals*. You can check items off as you shop.
- **Sunday deliveries.** A printable delivery route sorted by address, plus a separate pickup list. It flags customers with no address on file.
- **Menu management.** Ingredients are typed in plain text (`0.4 lb chicken breast`). Removing a meal from the menu keeps it on file, so past invoices stay accurate.
- **Cloud sync with a login.** Data lives in a Supabase Postgres database, protected by Row Level Security. Changes appear live on your phone and laptop through Supabase Realtime.
- **Demo mode.** Visitors click *Explore the demo* to try the full app on sample data stored in their own browser. Nothing touches the real database.
- **First-run migration.** On first sign-in, the app offers to copy data from the browser, load demo data, start blank or import a backup.
- **Backups.** Export and import JSON anytime.
- **Responsive, with dark mode.** Works on a phone at the stove or a laptop at the desk.

## Screenshots

| Orders + live preview | Invoice |
|---|---|
| ![Orders](docs/screenshot-orders.png) | ![Invoice](docs/screenshot-invoice.png) |

| Saturday prep | Customer macros (dark mode) |
|---|---|
| ![Prep](docs/screenshot-prep.png) | ![Customers](docs/screenshot-customers-dark.png) |

## Cloud sync (Supabase)

![Login](docs/screenshot-login.png)

How it works:

- `supabase/schema.sql` creates four tables: `settings`, `meals`, `customers` and `orders`. Every row has an `owner_id` that defaults to `auth.uid()`.
- **Row Level Security** gives each account access only to its own rows. That's why the publishable key in `js/config.js` can safely be public.
- Primary keys are `(owner_id, id)`, so two accounts can never collide on IDs.
- A composite foreign key stops an order from pointing at a customer that doesn't exist, or at another account's customer.
- Saves are **optimistic**: the UI updates instantly and writes in the background. If a write fails, the app warns you and reloads the true state from the database.
- **Realtime** subscriptions keep devices in sync. An incoming update never wipes a form you're halfway through typing.

To use your own Supabase project:

1. Run `supabase/schema.sql` in the Supabase SQL Editor.
2. Create your login under **Authentication → Users → Add user**, then turn off public sign-ups.
3. Put your project URL and **publishable** key in `js/config.js`. Never use a secret or service-role key there.

To run with no cloud at all, leave both values in `js/config.js` empty. The app then saves everything in the browser.

## Run it

No install is needed. Clone the repo and open `index.html` in a browser.

```bash
git clone https://github.com/<your-username>/fuel-by-buzah.git
cd fuel-by-buzah
open index.html        # macOS  (Windows: start index.html)
```

Open it and click **Explore the demo** to try every screen with sample data, or sign in to use your cloud database.

## Tests

The business rules (order windows, pricing, macros, shopping-list aggregation, validation) live in `js/logic.js`, and the database row mapping lives in `js/store.js`. Both are pure functions with no DOM access, covered by unit tests using Node's built-in test runner, so no dependencies are needed.

```bash
npm test
```

The tests run automatically on every push via GitHub Actions.

## Project structure

```
index.html            App shell
css/styles.css        Styles (CSS variables, light/dark, print styles)
js/logic.js           Pure business logic — used by the browser and by Node tests
js/seed.js            Demo data
js/store.js           Storage layer: LocalStore (browser) + CloudStore (Supabase)
js/config.js          Supabase URL + publishable key
js/app.js             UI: rendering, events, login, live sync
supabase/schema.sql   Tables, Row Level Security policies, realtime
tests/                Unit tests (node --test)
```

Design choices:

- **Storage sits behind one interface.** The UI calls `persist(op)` with small operations like `upsert`, `remove` and `settings`. `LocalStore` and `CloudStore` both implement it, so the same UI runs offline or synced.
- **Logic is kept separate from UI.** `logic.js` uses a small UMD wrapper, so the same file runs in the browser (as `window.FuelLogic`) and in Node (via `require`). All the rules that matter are tested without a browser.
- **No build step.** The app uses plain `<script>` tags, so it opens straight from the file system and deploys as-is.
- **Money is rounded to cents at every step**, which avoids floating-point errors (`0.1 + 0.2`).
- **Dates are local `YYYY-MM-DD` strings.** This avoids timezone bugs where a Sunday in Houston turns into Monday in UTC.

## Deploy to GitHub Pages

1. Push the repo to GitHub.
2. Go to **Settings → Pages → Build and deployment**, set Source to **Deploy from a branch**, then choose `main` / `(root)`.
3. The app will be live at `https://<your-username>.github.io/fuel-by-buzah/`.

## Roadmap

- Customer-facing order form (shareable link) that writes into the same database
- Weekly revenue history chart
- Route optimization for deliveries

## License

MIT
