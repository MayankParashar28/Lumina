// 🧱 Phase-5: Prometheus metrics. Exposes default Node runtime metrics (CPU,
// memory, event-loop lag, GC) plus per-request HTTP rate / latency / error metrics,
// so you can chart p95 latency and error rate and alert on them.
const client = require("prom-client");

const register = new client.Registry();
register.setDefaultLabels({ app: "lumina" });
client.collectDefaultMetrics({ register });

const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

const httpTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

// Collapse ids to keep label cardinality low (one series per route, not per blog).
function normalizeRoute(req) {
  if (req.route) return ((req.baseUrl || "") + req.route.path) || "/";
  return (req.path || "/")
    .replace(/\/[a-f\d]{24}(?=\/|$)/gi, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:n");
}

function httpMetricsMiddleware(req, res, next) {
  // /metrics itself shouldn't pollute the metrics.
  if (req.path === "/metrics") return next();
  const end = httpDuration.startTimer();
  res.on("finish", () => {
    const labels = {
      method: req.method,
      route: normalizeRoute(req),
      status_code: res.statusCode,
    };
    end(labels);
    httpTotal.inc(labels);
  });
  next();
}

module.exports = { register, client, httpMetricsMiddleware };
