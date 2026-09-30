# Fuel by Buzah — Meal Prep Manager

A web app for running a small weekly meal-prep business. It has two sides:

- **The manager** (`index.html`) is for the owner: orders, macros, Saturday's shopping list, Sunday's deliveries and invoices.
- **The ordering page** (`order.html`) is for customers: they build their week of meals, see their macros and place an order, which lands in the manager for the owner to confirm.

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

## Online ordering (v2)

| Customer ordering page | Order confirmation | New orders inbox (manager) |
|---|---|---|
| ![Order page](docs/screenshot-shop-mobile.png) | ![Confirmation](docs/screenshot-shop-confirm.png) | ![Inbox](docs/screenshot-inbox.png) |

- **Shareable link.** Each shop gets `order.html?shop=<name>`, with an open/closed switch in Settings.
- **Customers see macros as they shop.** Totals and per-day averages are shown, and customers can enter daily goals to compare against. Those goals fill in their macro targets in the manager.
- **Owner approval.** Online orders arrive as *pending*, with a live alert, a tab badge and a count in the browser tab. The owner confirms or declines each one, and only confirmed orders count toward prep, deliveries and revenue.
- **Payments outside the app.** Customers pick Cash App, Zelle or cash, and the confirmation screen shows the owner's handle plus an order reference for the note. The manager has a Paid toggle on every order.
- **Returning customers are matched by phone number**, whatever the formatting. A public form can never overwrite a customer's saved details; it only fills in blanks.
- **Phone alerts.** Every new online order pushes a notification to the owner's phone through the free [ntfy](https://ntfy.sh) app, e.g. *"New order: Keisha · 3 meals · $51.00 · delivery Sun, Oct 4"*. Tapping it opens the manager's Orders tab.
- **Try it:** open `order.html?demo` for a demo that sends nothing.

### How phone alerts work (`supabase/v3_order_alerts.sql`)

An `AFTER INSERT` trigger on `orders` fires only for new **pending online** orders. It queues an HTTPS request with **pg_net**, Postgres's async HTTP client, to ntfy.sh, and ntfy pushes the notification to the phone.

- **Never blocks an order.** The request is sent in the background after the order commits, and any error inside the trigger is swallowed.
- **Minimal data.** The alert holds only the first name, meal count, total and delivery day. There is no address, phone number or last name.
- **Unguessable topic.** The ntfy topic is a random 24-character string generated in the browser with `crypto.getRandomValues`. It is stored in the owner's settings, which RLS protects, and is never returned by `get_shop()`.
- **Test button.** "Send test alert" calls an owner-only function, `send_test_alert()`, which uses the caller's own settings.
- **Safe tap link.** The tap-through link must be `https://` or it's dropped.

Why not SMS? US carriers shut down the free email-to-text gateways, and texting through a provider like Twilio now requires A2P 10DLC business registration. Push notifications are free and instant with no registration. SMS could be added later behind the same trigger.

### How the ordering page stays secure

Customers never get table access. The public page can call exactly two Postgres functions (`supabase/v2_online_ordering.sql`):

| Function | What it does |
|---|---|
| `get_shop(slug)` | Returns the active menu (names, prices, macros, but no ingredients or costs), fees and payment handles |
| `place_order(slug, order)` | Validates everything, **re-prices the order on the server** so a tampered browser can't change the total, applies the order-window rules in the shop's time zone, matches or creates the customer, and inserts a **pending** order |

Validation covers name, phone, address, allowed payment methods, whole quantities from 1 to 50, active meals from this shop only, no duplicate lines, and a maximum of 60 meals. There are also spam guards: at most 3 pending orders per phone and 100 per shop, plus a hidden honeypot field. The order-window rule lives in a private schema (`fuel_private`) that the public API can't reach.

The SQL is covered by 42 ordering tests and 16 alert tests. They include parity checks showing the database computes the **same week and the same total as `js/logic.js`** across 42 day/policy combinations and 40 randomized orders.

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
- **Realtime** subscriptions keep devices in sync. An incoming update never wipes a form you're halfway through typing. Every remote event triggers a reload, and the page only re-renders when the data actually changed, so a customer order that lands a split second after the owner saves something is never dropped.

To use your own Supabase project:

1. Run `supabase/schema.sql`, then `supabase/v2_online_ordering.sql`, then `supabase/v3_order_alerts.sql`, in the Supabase SQL Editor. All three are safe to re-run.
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
index.html            Manager app shell
order.html            Customer ordering page
css/styles.css        Styles (CSS variables, light/dark, print styles)
css/order.css         Ordering page styles
js/logic.js           Pure business logic — used by the browser and by Node tests
js/seed.js            Demo data
js/store.js           Storage layer: LocalStore (browser) + CloudStore (Supabase)
js/config.js          Supabase URL + publishable key
js/app.js             Manager UI: rendering, events, login, live sync, order inbox
js/order.js           Ordering page: menu, cart, macros, checkout
supabase/schema.sql   Tables, Row Level Security policies, realtime
supabase/v2_online_ordering.sql   Shops, order status/payments, public order functions
supabase/v3_order_alerts.sql      Push alerts for new orders (trigger + pg_net + ntfy)
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

- SMS alerts via Twilio (once A2P 10DLC registration is approved)
- Automatic "order confirmed" texts to customers (with opt-in)
- Card payments with Stripe Checkout
- Weekly revenue history chart
- Route optimization for deliveries

## License

MIT
