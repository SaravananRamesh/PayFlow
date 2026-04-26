const express = require('express');
const os = require('os');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const START_TIME = Date.now();

// ─── PostgreSQL connection pool ───
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'payflow',
  user: process.env.DB_USER || 'payflow',
  password: process.env.DB_PASSWORD,
});

// ─── Initialize DB schema and seed data ───
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id VARCHAR(20) PRIMARY KEY,
        client VARCHAR(255) NOT NULL,
        amount NUMERIC(10,2) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        due DATE,
        created DATE DEFAULT CURRENT_DATE
      )
    `);

    const { rowCount } = await client.query('SELECT 1 FROM invoices LIMIT 1');
    if (rowCount === 0) {
      await client.query(`
        INSERT INTO invoices (id, client, amount, status, due, created) VALUES
        ('INV-001', 'Oakwood Design Co.', 2400.00, 'paid', '2026-03-15', '2026-03-01'),
        ('INV-002', 'Riverstone Legal LLC', 5750.00, 'pending', '2026-04-30', '2026-04-01'),
        ('INV-003', 'Summit Analytics', 1200.00, 'overdue', '2026-03-20', '2026-02-20'),
        ('INV-004', 'Greenleaf Catering', 890.00, 'paid', '2026-04-10', '2026-03-25'),
        ('INV-005', 'Nexus Digital Agency', 3300.00, 'pending', '2026-05-15', '2026-04-18')
      `);
      console.log('Seeded default invoices');
    }
    console.log('Database initialized');
  } finally {
    client.release();
  }
}

// ─── Helper: get next invoice ID ───
async function getNextId() {
  const { rows } = await pool.query("SELECT id FROM invoices ORDER BY id DESC LIMIT 1");
  if (rows.length === 0) return 'INV-001';
  const lastNum = parseInt(rows[0].id.replace('INV-', ''));
  return `INV-${String(lastNum + 1).padStart(3, '0')}`;
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Admin auth middleware ───
function requireAdmin(req, res, next) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const provided = req.headers['x-admin-password'];
  if (!adminPassword) return res.status(500).json({ error: 'ADMIN_PASSWORD secret not configured' });
  if (provided !== adminPassword) return res.status(401).json({ error: 'Unauthorized — invalid admin password' });
  next();
}

// ─── Health endpoint ───
app.get('/health', async (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);
  let dbStatus = 'ok';
  try {
    await pool.query('SELECT 1');
  } catch (e) {
    dbStatus = 'error';
  }
  res.json({
    status: 'healthy',
    pod: os.hostname(),
    uptime: `${uptimeSeconds}s`,
    memory: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    db: dbStatus
  });
});

// ─── Metrics ───
app.get('/metrics', async (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);
  const memoryMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const { rows } = await pool.query('SELECT COUNT(*) FROM invoices');
  res.type('text/plain').send(
    `payflow_uptime_seconds ${uptimeSeconds}\n` +
    `payflow_invoices_total ${rows[0].count}\n` +
    `payflow_memory_mb ${memoryMB}\n` +
    `payflow_pod_info{pod="${os.hostname()}"} 1\n`
  );
});

// ─── API: List invoices (public) ───
app.get('/invoices', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM invoices ORDER BY id');
  res.json({ count: rows.length, invoices: rows });
});

// ─── API: Create invoice (admin protected) ───
app.post('/invoices', requireAdmin, async (req, res) => {
  const { client, amount, due } = req.body;
  if (!client || !amount) return res.status(400).json({ error: 'client and amount are required' });
  const id = await getNextId();
  const dueDate = due || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const { rows } = await pool.query(
    'INSERT INTO invoices (id, client, amount, due) VALUES ($1, $2, $3, $4) RETURNING *',
    [id, client, parseFloat(amount), dueDate]
  );
  res.status(201).json(rows[0]);
});

// ─── API: Update invoice status (admin protected) ───
app.patch('/invoices/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const { rows, rowCount } = await pool.query(
    'UPDATE invoices SET status = $1 WHERE id = $2 RETURNING *',
    [status, id]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Invoice not found' });
  res.json(rows[0]);
});

// ─── API: Delete invoice (admin protected) ───
app.delete('/invoices/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { rowCount } = await pool.query('DELETE FROM invoices WHERE id = $1', [id]);
  if (rowCount === 0) return res.status(404).json({ error: 'Invoice not found' });
  res.json({ deleted: id });
});

// ─── HPA demo endpoint ───
app.get('/generate-report', async (req, res) => {
  let sum = 0;
  for (let i = 0; i < 1e7; i++) sum += Math.sqrt(i) * Math.sin(i);
  const { rows } = await pool.query('SELECT * FROM invoices');
  const totalRevenue = rows.reduce((acc, inv) => acc + parseFloat(inv.amount), 0);
  const paidCount = rows.filter(inv => inv.status === 'paid').length;
  res.json({
    report: 'Monthly Invoice Summary',
    totalInvoices: rows.length,
    totalRevenue: totalRevenue.toFixed(2),
    paidInvoices: paidCount,
    pendingInvoices: rows.filter(inv => inv.status === 'pending').length,
    overdueInvoices: rows.filter(inv => inv.status === 'overdue').length,
    collectionRate: `${((paidCount / rows.length) * 100).toFixed(1)}%`,
    generatedBy: os.hostname(),
    computeToken: sum.toFixed(2)
  });
});

// ─── Landing page ───
app.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM invoices ORDER BY id');
  const totalRevenue = rows.reduce((acc, inv) => acc + parseFloat(inv.amount), 0);
  const paidCount = rows.filter(inv => inv.status === 'paid').length;
  const pendingCount = rows.filter(inv => inv.status === 'pending').length;
  const overdueCount = rows.filter(inv => inv.status === 'overdue').length;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PayFlow — Invoice Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0d0f12;
      --surface: #13161a;
      --surface2: #1a1e24;
      --border: #232830;
      --accent: #00e5a0;
      --accent2: #0077ff;
      --warn: #ffb547;
      --danger: #ff4d6a;
      --text: #e8ecf0;
      --muted: #6b7585;
    }
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'DM Sans',sans-serif; background:var(--bg); color:var(--text); min-height:100vh; }

    .header {
      padding:20px 32px;
      border-bottom:1px solid var(--border);
      display:flex; align-items:center; justify-content:space-between;
      background:var(--surface);
      position:sticky; top:0; z-index:100;
    }
    .logo { font-family:'DM Mono',monospace; font-size:18px; color:var(--accent); }
    .logo span { color:var(--muted); }
    .pod-tag { font-family:'DM Mono',monospace; font-size:11px; color:var(--muted); background:var(--surface2); padding:4px 10px; border-radius:4px; border:1px solid var(--border); }

    .main { max-width:1100px; margin:0 auto; padding:28px 32px; }

    .metrics { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:28px; }
    .metric { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:18px 20px; }
    .metric .label { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:1px; margin-bottom:8px; }
    .metric .val { font-family:'DM Mono',monospace; font-size:26px; font-weight:500; }
    .metric .val.green { color:var(--accent); }
    .metric .val.amber { color:var(--warn); }
    .metric .val.red { color:var(--danger); }
    .metric .val.blue { color:var(--accent2); }

    .modal-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:200; align-items:center; justify-content:center; }
    .modal-overlay.open { display:flex; }
    .modal { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:28px; width:360px; }
    .modal h3 { font-size:15px; margin-bottom:6px; }
    .modal p { font-size:12px; color:var(--muted); margin-bottom:18px; line-height:1.6; }
    .modal input { width:100%; background:var(--surface2); border:1px solid var(--border); color:var(--text); padding:10px 12px; border-radius:6px; font-size:13px; outline:none; margin-bottom:12px; font-family:'DM Mono',monospace; }
    .modal input:focus { border-color:var(--accent2); }
    .modal-actions { display:flex; gap:8px; justify-content:flex-end; }
    .error-msg { font-size:12px; color:var(--danger); margin-bottom:10px; display:none; }

    .btn { padding:9px 18px; border-radius:6px; border:none; cursor:pointer; font-family:'DM Sans',sans-serif; font-size:13px; font-weight:500; transition:all 0.15s; }
    .btn-primary { background:var(--accent2); color:#fff; }
    .btn-primary:hover { background:#0066dd; }
    .btn-ghost { background:transparent; border:1px solid var(--border); color:var(--muted); }
    .btn-ghost:hover { color:var(--text); border-color:var(--text); }

    .add-form { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:20px; margin-bottom:24px; }
    .form-row { display:grid; grid-template-columns:2fr 1fr 1fr auto; gap:10px; align-items:end; }
    .field label { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:0.8px; display:block; margin-bottom:6px; }
    .field input { background:var(--surface2); border:1px solid var(--border); color:var(--text); padding:9px 12px; border-radius:6px; font-family:'DM Sans',sans-serif; font-size:13px; width:100%; outline:none; transition:border-color 0.2s; }
    .field input:focus { border-color:var(--accent2); }
    .field input:disabled { opacity:0.4; cursor:not-allowed; }

    .section-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
    .section-title { font-size:13px; font-weight:600; text-transform:uppercase; letter-spacing:1px; color:var(--muted); }
    .lock-badge { font-size:11px; color:var(--warn); background:rgba(255,181,71,0.1); border:1px solid rgba(255,181,71,0.3); padding:3px 10px; border-radius:4px; font-family:'DM Mono',monospace; cursor:pointer; }
    .lock-badge:hover { background:rgba(255,181,71,0.2); }
    .unlock-badge { font-size:11px; color:var(--accent); background:rgba(0,229,160,0.1); border:1px solid rgba(0,229,160,0.3); padding:3px 10px; border-radius:4px; font-family:'DM Mono',monospace; cursor:pointer; }
    .unlock-badge:hover { background:rgba(0,229,160,0.2); }

    .table-wrap { background:var(--surface); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
    table { width:100%; border-collapse:collapse; }
    th { background:var(--surface2); text-align:left; padding:11px 16px; font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:0.8px; font-weight:600; }
    td { padding:13px 16px; border-top:1px solid var(--border); font-size:13px; }
    tr:hover td { background:var(--surface2); }
    .badge { display:inline-block; padding:3px 9px; border-radius:4px; font-size:11px; font-weight:600; font-family:'DM Mono',monospace; }
    .badge.paid { background:rgba(0,229,160,0.12); color:var(--accent); }
    .badge.pending { background:rgba(255,181,71,0.12); color:var(--warn); }
    .badge.overdue { background:rgba(255,77,106,0.12); color:var(--danger); }
    .amount { font-family:'DM Mono',monospace; }
    .actions { display:flex; gap:6px; }
    .btn-sm { padding:4px 10px; font-size:11px; border-radius:4px; border:1px solid var(--border); background:transparent; color:var(--muted); cursor:pointer; font-family:'DM Mono',monospace; transition:all 0.15s; }
    .btn-sm:hover:not(:disabled) { background:var(--surface2); color:var(--text); }
    .btn-sm.mark-paid:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); }
    .btn-sm.delete:hover:not(:disabled) { border-color:var(--danger); color:var(--danger); }
    .btn-sm:disabled { opacity:0.25; cursor:not-allowed; }
  </style>
</head>
<body>

  <div class="modal-overlay" id="modal">
    <div class="modal">
      <h3>Admin Access</h3>
      <p>Enter the admin password to add, update, or delete invoices. This password is stored as a <strong>Kubernetes Secret</strong> and injected at runtime — never hardcoded.</p>
      <div class="error-msg" id="modal-error">Incorrect password. Try again.</div>
      <input type="password" id="modal-input" placeholder="Admin password" onkeydown="if(event.key==='Enter')confirmLogin()">
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="confirmLogin()">Unlock</button>
      </div>
    </div>
  </div>

  <div class="header">
    <div class="logo">pay<span>/</span>flow</div>
    <div class="pod-tag">pod: ${os.hostname()}</div>
  </div>

  <div class="main">
    <div class="metrics">
      <div class="metric">
        <div class="label">Total Revenue</div>
        <div class="val blue">$${totalRevenue.toLocaleString('en-US',{minimumFractionDigits:2})}</div>
      </div>
      <div class="metric">
        <div class="label">Paid</div>
        <div class="val green">${paidCount}</div>
      </div>
      <div class="metric">
        <div class="label">Pending</div>
        <div class="val amber">${pendingCount}</div>
      </div>
      <div class="metric">
        <div class="label">Overdue</div>
        <div class="val red">${overdueCount}</div>
      </div>
    </div>

    <div class="add-form">
      <div class="section-header" style="margin-bottom:14px">
        <div class="section-title">New Invoice</div>
        <span class="lock-badge" id="lock-badge" onclick="openModal()">🔒 locked — click to unlock</span>
        <span class="unlock-badge" id="unlock-badge" style="display:none" onclick="logout()">🔓 admin mode — click to lock</span>
      </div>
      <div class="form-row">
        <div class="field">
          <label>Client</label>
          <input type="text" id="f-client" placeholder="Acme Corp" disabled>
        </div>
        <div class="field">
          <label>Amount ($)</label>
          <input type="number" id="f-amount" placeholder="1500" disabled>
        </div>
        <div class="field">
          <label>Due Date</label>
          <input type="date" id="f-due" disabled>
        </div>
        <button class="btn btn-primary" id="add-btn" onclick="addInvoice()" disabled>+ Add</button>
      </div>
    </div>

    <div class="section-header">
      <div class="section-title">Invoices</div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>ID</th><th>Client</th><th>Amount</th><th>Status</th><th>Due</th><th>Actions</th></tr>
        </thead>
        <tbody id="invoice-tbody"></tbody>
      </table>
    </div>
  </div>

  <script>
    let adminPassword = null;
    let isAdmin = false;

    function openModal() {
      document.getElementById('modal').classList.add('open');
      document.getElementById('modal-error').style.display = 'none';
      document.getElementById('modal-input').value = '';
      setTimeout(() => document.getElementById('modal-input').focus(), 100);
    }

    function closeModal() {
      document.getElementById('modal').classList.remove('open');
    }

    async function confirmLogin() {
      const pw = document.getElementById('modal-input').value;
      const res = await fetch('/invoices/INV-AUTH-TEST', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': pw },
        body: JSON.stringify({ status: 'pending' })
      });
      if (res.status === 401) {
        document.getElementById('modal-error').style.display = 'block';
        return;
      }
      adminPassword = pw;
      isAdmin = true;
      closeModal();
      setAdminUI(true);
    }

    function logout() {
      adminPassword = null;
      isAdmin = false;
      setAdminUI(false);
    }

    function setAdminUI(unlocked) {
      document.getElementById('lock-badge').style.display = unlocked ? 'none' : 'inline-block';
      document.getElementById('unlock-badge').style.display = unlocked ? 'inline-block' : 'none';
      ['f-client','f-amount','f-due'].forEach(id => {
        document.getElementById(id).disabled = !unlocked;
      });
      document.getElementById('add-btn').disabled = !unlocked;
      loadInvoices();
    }

    async function loadInvoices() {
      const res = await fetch('/invoices');
      const data = await res.json();
      renderTable(data.invoices);
    }

    function renderTable(list) {
      const tbody = document.getElementById('invoice-tbody');
      tbody.innerHTML = list.map(inv => \`
        <tr>
          <td><span style="font-family:'DM Mono',monospace;font-size:12px;color:var(--muted)">\${inv.id}</span></td>
          <td>\${inv.client}</td>
          <td class="amount">$\${parseFloat(inv.amount).toLocaleString('en-US',{minimumFractionDigits:2})}</td>
          <td><span class="badge \${inv.status}">\${inv.status}</span></td>
          <td style="font-family:'DM Mono',monospace;font-size:12px">\${inv.due ? inv.due.split('T')[0] : ''}</td>
          <td>
            <div class="actions">
              \${inv.status !== 'paid' ? \`<button class="btn-sm mark-paid" \${!isAdmin ? 'disabled' : ''} onclick="markPaid('\${inv.id}')">mark paid</button>\` : ''}
              <button class="btn-sm delete" \${!isAdmin ? 'disabled' : ''} onclick="deleteInvoice('\${inv.id}')">delete</button>
            </div>
          </td>
        </tr>
      \`).join('');
    }

    async function addInvoice() {
      const client = document.getElementById('f-client').value.trim();
      const amount = parseFloat(document.getElementById('f-amount').value);
      const due = document.getElementById('f-due').value;
      if (!client || !amount) return alert('Client and amount are required');
      const res = await fetch('/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
        body: JSON.stringify({ client, amount, due })
      });
      if (!res.ok) {
        const err = await res.json();
        return alert(err.error);
      }
      document.getElementById('f-client').value = '';
      document.getElementById('f-amount').value = '';
      document.getElementById('f-due').value = '';
      loadInvoices();
    }

    async function markPaid(id) {
      await fetch(\`/invoices/\${id}\`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
        body: JSON.stringify({ status: 'paid' })
      });
      loadInvoices();
    }

    async function deleteInvoice(id) {
      if (!confirm('Delete this invoice?')) return;
      await fetch(\`/invoices/\${id}\`, {
        method: 'DELETE',
        headers: { 'x-admin-password': adminPassword }
      });
      loadInvoices();
    }

    loadInvoices();
  </script>
</body>
</html>`);
});

// ─── Start server ───
async function start() {
  let retries = 10;
  while (retries > 0) {
    try {
      await initDB();
      break;
    } catch (e) {
      console.log(`DB not ready, retrying... (${retries} left): ${e.message}`);
      retries--;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  app.listen(PORT, () => {
    console.log(`PayFlow v2.0 running on port ${PORT} | Pod: ${os.hostname()}`);
  });
}

start();