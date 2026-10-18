// 🧱 Phase-5 load test (k6).
//
// Install k6 (brew install k6), then run against a target:
//   k6 run -e BASE_URL=https://your-app.onrender.com loadtest/k6-script.js
//
// Models read-heavy traffic (anonymous landing + blog views + some search), ramps
// to 200 virtual users, and fails the run if error rate or p95 latency breach the
// thresholds below — so you can set autoscaling + alerts from real numbers.
import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:8000";
const BLOG_ID = __ENV.BLOG_ID || "6967c754e6f1a6c190487d8a";

export const options = {
  stages: [
    { duration: "30s", target: 50 },   // warm up
    { duration: "1m", target: 200 },   // sustained load
    { duration: "30s", target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_failed: ["rate<0.01"],        // < 1% errors
    http_req_duration: ["p(95)<500"],      // 95% of requests under 500ms
  },
};

export default function () {
  // Landing page (CDN-cacheable path).
  const landing = http.get(`${BASE}/`);
  check(landing, { "landing 200": (r) => r.status === 200 });
  sleep(0.5);

  // A blog page (CDN-cacheable path).
  const blog = http.get(`${BASE}/blog/${BLOG_ID}`);
  check(blog, { "blog 200": (r) => r.status === 200 });
  sleep(0.5);

  // ~30% of sessions also search (hits the app + vector/text search).
  if (Math.random() < 0.3) {
    const search = http.get(`${BASE}/blog/search?q=software`);
    check(search, { "search ok": (r) => r.status === 200 });
  }

  sleep(1);
}
