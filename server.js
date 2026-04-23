const express = require('express');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const START_TIME = Date.now();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory invoice store (simulates database)
let invoices = [
  { id: 'INV-001', client: 'Oakwood Design Co.', amount: 2400.00, status: 'paid', due: '2026-03-15', created: '2026-03-01' },
  { id: 'INV-002', client: 'Riverstone Legal LLC', amount: 5750.00, status: 'pending', due: '2026-04-30', created: '2026-04-01' },
  { id: 'INV-003', client: 'Summit Analytics', amount: 1200.00, status: 'overdue', due: '2026-03-20', created: '2026-02-20' },
  { id: 'INV-004', client: 'Greenleaf Catering', amount: 890.00, status: 'paid', due: '2026-04-10', created: '2026-03-25' },
  { id: 'INV-005', client: 'Nexus Digital Agency', amount: 3300.00, status: 'pending', due: '2026-05-15', created: '2026-04-18' },
];
let nextId = 6;

// ─── Health endpoint (proves load balancing + pod identity) ───
app.get('/health', (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);
  res.json({
    status: 'healthy',
    pod: os.hostname(),
    uptime: `${uptimeSeconds}s`,
    memory: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// ─── Prometheus-style metrics stub ───
app.get('/metrics', (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);
  const memoryMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  res.type('text/plain').send(
    `# HELP payflow_uptime_seconds App uptime in seconds\n` +
    `payflow_uptime_seconds ${uptimeSeconds}\n` +
    `# HELP payflow_invoices_total Total invoices in system\n` +
    `payflow_invoices_total ${invoices.length}\n` +
    `# HELP payflow_memory_mb Memory usage in MB\n` +
    `payflow_memory_mb ${memoryMB}\n` +
    `# HELP payflow_pod_info Pod information\n` +
    `payflow_pod_info{pod="${os.hostname()}"} 1\n`
  );
});

// ─── API: List invoices ───
app.get('/invoices', (req, res) => {
  res.json({ count: invoices.length, invoices });
});

// ─── API: Create invoice ───
app.post('/invoices', (req, res) => {
  const { client, amount, due } = req.body;
  if (!client || !amount) {
    return res.status(400).json({ error: 'client and amount are required' });
  }
  const invoice = {
    id: `INV-${String(nextId++).padStart(3, '0')}`,
    client,
    amount: parseFloat(amount),
    status: 'pending',
    due: due || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    created: new Date().toISOString().split('T')[0]
  };
  invoices.push(invoice);
  res.status(201).json(invoice);
});

// ─── CPU-intensive endpoint for load testing / HPA demo ───
app.get('/generate-report', (req, res) => {
  // Simulates a heavy computation (invoice report generation)
  let sum = 0;
  for (let i = 0; i < 1e7; i++) {
    sum += Math.sqrt(i) * Math.sin(i);
  }
  const totalRevenue = invoices.reduce((acc, inv) => acc + inv.amount, 0);
  const paidCount = invoices.filter(inv => inv.status === 'paid').length;
  res.json({
    report: 'Monthly Invoice Summary',
    totalInvoices: invoices.length,
    totalRevenue: totalRevenue.toFixed(2),
    paidInvoices: paidCount,
    pendingInvoices: invoices.filter(inv => inv.status === 'pending').length,
    overdueInvoices: invoices.filter(inv => inv.status === 'overdue').length,
    collectionRate: `${((paidCount / invoices.length) * 100).toFixed(1)}%`,
    generatedBy: os.hostname(),
    computeToken: sum.toFixed(2)
  });
});

// ─── Landing page ───
app.get('/', (req, res) => {
  const totalRevenue = invoices.reduce((acc, inv) => acc + inv.amount, 0);
  const paidCount = invoices.filter(inv => inv.status === 'paid').length;
  const pendingCount = invoices.filter(inv => inv.status === 'pending').length;
  const overdueCount = invoices.filter(inv => inv.status === 'overdue').length;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PayFlow — Invoice Dashboard</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; background:#f7f8fc; color:#1a1a2e; }
    .header { background:linear-gradient(135deg, #0061FF 0%, #003ECB 100%); color:#fff; padding:24px 32px; }
    .header h1 { font-size:24px; font-weight:700; letter-spacing:-0.5px; }
    .header p { opacity:0.85; font-size:14px; margin-top:4px; }
    .pod-badge { display:inline-block; background:rgba(255,255,255,0.15); padding:4px 12px; border-radius:20px; font-size:12px; margin-top:8px; font-family:monospace; }
    .container { max-width:960px; margin:0 auto; padding:24px; }
    .metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:16px; margin-bottom:32px; }
    .metric-card { background:#fff; border-radius:12px; padding:20px; border:1px solid #e8eaf0; }
    .metric-card .label { font-size:13px; color:#6b7280; text-transform:uppercase; letter-spacing:0.5px; }
    .metric-card .value { font-size:28px; font-weight:700; margin-top:4px; }
    .metric-card .value.green { color:#059669; }
    .metric-card .value.amber { color:#d97706; }
    .metric-card .value.red { color:#dc2626; }
    .metric-card .value.blue { color:#0061FF; }
    table { width:100%; border-collapse:collapse; background:#fff; border-radius:12px; overflow:hidden; border:1px solid #e8eaf0; }
    th { background:#f9fafb; text-align:left; padding:14px 16px; font-size:13px; color:#6b7280; text-transform:uppercase; letter-spacing:0.5px; font-weight:600; }
    td { padding:14px 16px; border-top:1px solid #f0f1f5; font-size:14px; }
    .status { display:inline-block; padding:3px 10px; border-radius:20px; font-size:12px; font-weight:600; }
    .status.paid { background:#d1fae5; color:#065f46; }
    .status.pending { background:#fef3c7; color:#92400e; }
    .status.overdue { background:#fee2e2; color:#991b1b; }
    .footer { text-align:center; padding:24px; font-size:12px; color:#9ca3af; }
    h2 { font-size:18px; font-weight:600; margin-bottom:16px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>PayFlow</h1>
    <p>Invoice & Billing Dashboard for SMBs</p>
    <div class="pod-badge">Pod: ${os.hostname()}</div>
  </div>
  <div class="container">
    <div class="metrics">
      <div class="metric-card">
        <div class="label">Total revenue</div>
        <div class="value blue">$${totalRevenue.toLocaleString('en-US', {minimumFractionDigits:2})}</div>
      </div>
      <div class="metric-card">
        <div class="label">Paid</div>
        <div class="value green">${paidCount}</div>
      </div>
      <div class="metric-card">
        <div class="label">Pending</div>
        <div class="value amber">${pendingCount}</div>
      </div>
      <div class="metric-card">
        <div class="label">Overdue</div>
        <div class="value red">${overdueCount}</div>
      </div>
    </div>
    <h2>Recent invoices</h2>
    <table>
      <thead>
        <tr><th>Invoice</th><th>Client</th><th>Amount</th><th>Status</th><th>Due date</th></tr>
      </thead>
      <tbody>
        ${invoices.map(inv => `
        <tr>
          <td><strong>${inv.id}</strong></td>
          <td>${inv.client}</td>
          <td>$${inv.amount.toLocaleString('en-US', {minimumFractionDigits:2})}</td>
          <td><span class="status ${inv.status}">${inv.status}</span></td>
          <td>${inv.due}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
  <div class="footer">
    PayFlow v1.0.0 · Deployed on DigitalOcean Kubernetes (DOKS) · Pod: ${os.hostname()}
  </div>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`PayFlow server running on port ${PORT} | Pod: ${os.hostname()}`);
});
