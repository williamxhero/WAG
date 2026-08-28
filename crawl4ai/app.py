import asyncio
import base64
import ipaddress
import os
import socket
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

TOKEN = os.environ["CRAWL4AI_TOKEN"]
EGRESS_PROXY = os.environ.get("EGRESS_PROXY", "http://127.0.0.1:7895")
MAX_CONCURRENCY = int(os.environ.get("CRAWL4AI_MAX_CONCURRENCY", "2"))
DATA_DIR = os.environ["CRAWL4AI_DATA_DIR"]
semaphore = asyncio.Semaphore(MAX_CONCURRENCY)
crawler: AsyncWebCrawler | None = None


class CrawlRequest(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=1)
    browser_config: dict = {}
    crawler_config: dict = {}


def public_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(400, "only absolute http(s) URLs are allowed")
    try:
        records = socket.getaddrinfo(parsed.hostname, None, type=socket.SOCK_STREAM)
        addresses = {record[4][0] for record in records}
    except socket.gaierror as exc:
        raise HTTPException(400, "URL hostname could not be resolved") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
            raise HTTPException(400, "private, loopback, link-local, and reserved addresses are blocked")
    return value


def check_token(authorization: str | None) -> None:
    if authorization != f"Bearer {TOKEN}":
        raise HTTPException(401, "Bearer token required")


@asynccontextmanager
async def lifespan(_: FastAPI):
    global crawler
    browser = BrowserConfig(headless=True, verbose=False, proxy_config={"server": EGRESS_PROXY}, extra_args=["--disable-quic", "--disable-features=ServiceWorker"])
    crawler = AsyncWebCrawler(config=browser, base_directory=DATA_DIR, thread_safe=True)
    await crawler.start()
    try:
        yield
    finally:
        if crawler is not None:
            await crawler.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/healthz")
async def healthz():
    return {"status": "ok", "concurrency": MAX_CONCURRENCY}


@app.post("/crawl")
async def crawl(request: CrawlRequest, authorization: str | None = Header(default=None)):
    check_token(authorization)
    url = public_url(request.urls[0])
    params = request.crawler_config.get("params", request.crawler_config)
    screenshot = bool(params.get("screenshot", False))
    pdf = bool(params.get("pdf", False))
    config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        screenshot=screenshot,
        pdf=pdf,
        page_timeout=60_000,
        word_count_threshold=1,
        remove_overlay_elements=True,
    )
    if crawler is None:
        raise HTTPException(503, "crawler is not ready")
    async with semaphore:
        try:
            result = await asyncio.wait_for(crawler.arun(url=url, config=config), timeout=90)
        except TimeoutError as exc:
            raise HTTPException(504, "Crawl4AI timed out") from exc
    if not result.success:
        raise HTTPException(502, result.error_message or "Crawl4AI failed")
    pdf_data = result.pdf
    if isinstance(pdf_data, bytes):
        pdf_data = base64.b64encode(pdf_data).decode("ascii")
    return {
        "results": [{
            "markdown": str(result.markdown or ""),
            "screenshot": result.screenshot,
            "pdf": pdf_data,
            "url": result.url,
        }]
    }
