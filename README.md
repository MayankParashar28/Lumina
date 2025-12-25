<div align="center">

# 🚀 Lumina

### **AI-Powered Blogging Platform with Semantic Search**

[![Production Ready](https://img.shields.io/badge/STATUS-Production%20Ready-success?style=for-the-badge)](#)
[![Node.js](https://img.shields.io/badge/Node.js-v20+-339933?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![MongoDB](https://img.shields.io/badge/MongoDB-6.0+-47A248?style=for-the-badge&logo=mongodb)](https://www.mongodb.com/)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](#)

**A full-stack blogging platform featuring AI-powered semantic search, real-time notifications, vector embeddings, and modern web architecture.**

[Live Demo](https://lluminaa.vercel.app/) • [Docs](#-tech-stack) • [Report Bug](https://github.com/MayankParashar28/BlogiFy/issues) • [GitHub](https://github.com/MayankParashar28/BlogiFy)

</div>

---

## 📋 Table of Contents

- [✨ Features](#-features)
- [🛠️ Tech Stack](#-tech-stack)
- [🚀 Quick Start](#-quick-start)
- [📊 Performance](#-performance)
- [🔒 Security](#-security)
- [🧪 Testing](#-testing)
- [🤝 Contributing](#-contributing)
- [📄 License](#-license)

---

## ✨ Features

### 🧠 AI & Search
- **Semantic Search** using 768-dim vector embeddings
- **Smart Recommendations** with cosine similarity
- **AI Content Generation** via Google Gemini API
- **Auto Summarization** with TL;DR extraction
- **Related Posts** based on semantic proximity

### ⚡ Real-Time & UX
- **Live Notifications** via Socket.IO
- **Instant Updates** for likes, comments, follows
- **Dark/Light Themes** with smooth transitions
- **Responsive Design** with Bento grid layout
- **Infinite Scroll** with skeleton loading

### 🛡️ Core Features
- **Role-Based Access Control** (User, Creator, Admin)
- **User Authentication** with SHA-256 hashing
- **Admin Dashboard** for content moderation
- **Multi-format Content** support
- **View Tracking** and engagement metrics

---

## 🛠️ Tech Stack

| Layer | Technology | Why? |
|-------|-----------|------|
| **Backend** | Node.js + Express | Non-blocking I/O for real-time features |
| **Database** | MongoDB + Mongoose | Flexible schema, native array support for vectors |
| **AI/ML** | Google Gemini API | Cost-effective embeddings, high context window |
| **Real-time** | Socket.IO | Bi-directional WebSocket communication |
| **Rendering** | EJS (SSR) | Better SEO, faster FCP than SPAs |
| **Cloud** | Cloudinary | Image optimization and CDN delivery |
| **Logging** | Winston | Structured JSON logs for debugging |
| **Hosting** | Vercel/Render | Automated CI/CD and deployment |

---

## 🚀 Quick Start

### Prerequisites
```
Node.js >= 20.0.0
MongoDB >= 6.0
Google Gemini API Key
Cloudinary API Key (for image uploads)
```

### Installation

1. **Clone the repo**
   ```bash
   git clone https://github.com/MayankParashar28/BlogiFy.git
   cd BlogiFy
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Setup `.env`**
   ```env
   # Database
   MONGODB_URL=mongodb://localhost:27017/lumina
   
   # AI
   GOOGLE_GEMINI_API_KEY=your_api_key
   
   # Cloud Storage
   CLOUDINARY_NAME=your_cloud_name
   CLOUDINARY_API_KEY=your_api_key
   CLOUDINARY_API_SECRET=your_api_secret
   
   # Auth
   SESSION_SECRET=your_complex_secret
   
   # Server
   PORT=8000
   NODE_ENV=development
   ```

4. **Run the app**
   ```bash
   npm run dev     # Development
   npm start       # Production
   ```

5. **Access**
   - Frontend: `http://localhost:8000`
   - Admin: `http://localhost:8000/admin`

---

## 📊 Performance

### Core Web Vitals
| Metric | Target | Achieved |
|--------|--------|----------|
| **LCP** | < 2.5s | ✅ 1.8s |
| **FID** | < 100ms | ✅ 45ms |
| **CLS** | < 0.1 | ✅ 0.05 |
| **TTFB** | < 600ms | ✅ 420ms |

### Optimizations
- ✅ Brotli compression (70% reduction)
- ✅ Image optimization via Cloudinary
- ✅ Database indexing for fast queries
- ✅ Client-side lazy loading
- ✅ Static asset caching

---

## 🔒 Security

### Authentication
- SHA-256 password hashing with unique salts
- Session-based auth with secure cookies
- Rate limiting on sensitive endpoints

### Rate Limits
| Endpoint | Limit | Window |
|----------|-------|--------|
| Login/Signup | 5 req | 15 min |
| AI Generation | 10 req | 1 hour |
| Blog Creation | 1 req | 30 min |
| Comments | 1 req | 5 min |

### Security Headers (Helmet.js)
- ✅ Content Security Policy (CSP)
- ✅ HSTS (HTTP Strict Transport Security)
- ✅ X-Frame-Options (Clickjacking protection)
- ✅ X-Content-Type-Options (MIME sniffing)

---

## 🧪 Testing

```bash
npm test              # Unit tests
npm run test:integration  # Integration tests
npm run test:e2e      # End-to-end tests
```

---

## 🤝 Contributing

We welcome contributions! Follow these steps:

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit: `git commit -m 'feat: add amazing feature'`
4. Push: `git push origin feature/amazing-feature`
5. Open a Pull Request

### Commit Convention
Follow [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation
- `refactor:` Code refactoring
- `test:` Adding tests

---

## 🗺️ Roadmap

- [ ] Hybrid search (Vector + Keyword)
- [ ] Redis caching layer
- [ ] GraphQL API
- [ ] Mobile app (React Native)
- [ ] Background jobs (BullMQ)
- [ ] Advanced analytics
- [ ] Multi-language support (i18n)

---

## 📄 License

MIT License - see [LICENSE](https://github.com/MayankParashar28/BlogiFy/blob/main/LICENSE)

---

## 👨‍💻 Author

**Mayank Parashar**

- GitHub: [@MayankParashar28](https://github.com/MayankParashar28)
- LinkedIn: [Mayank Parashar](https://linkedin.com/in/mayankparashar)

---

**Built with ❤️ focusing on Performance, Clean Code, and Scalability**
