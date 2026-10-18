// 🧪 Gentle smoke / baseline load test (k6) — safe to run against production.
//
//   k6 run -e BASE_URL=https://your-app.onrender.com loadtest/k6-smoke.js
//
// Ramps to only ~20 concurrent users for ~1 minute: enough to measure real-world
// req/s and p95 latency on the free tier without risking an outage. For the full
// stress test (200 VUs, find the breaking point), use k6-script.js on staging.
import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:8000";
const BLOG_ID = __ENV.BLOG_ID || "6967c754e6f1a6c190487d8a";

export const options = {
  stages: [
    { duration: "15s", target: 10 },
    { duration: "30s", target: 20 },
    { duration: "15s", target: 0 },
  ],
  thresholds: {
    http_req_failed: ["rate<0.02"],
    http_req_duration: ["p(95)<1500"], // relaxed for free-tier + cold starts
  },
};

export default function () {
  const landing = http.get(`${BASE}/`);
  check(landing, { "landing 200": (r) => r.status === 200 });
  sleep(1);

  const blog = http.get(`${BASE}/blog/${BLOG_ID}`);
  check(blog, { "blog 200": (r) => r.status === 200 });
  sleep(1);
}
