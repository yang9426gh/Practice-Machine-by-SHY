/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "export",
  // FastAPI(8011)가 out/ 을 직접 서빙 — Next 서버 프로세스 불필요
  images: { unoptimized: true },
  trailingSlash: true,
};

module.exports = nextConfig;
