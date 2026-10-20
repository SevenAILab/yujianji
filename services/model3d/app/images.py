"""Conservative image preparation for single-object 3D reconstruction."""
from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_UPLOAD = 20 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 25_000_000


def normalize(raw: bytes) -> Image.Image:
    if len(raw) > MAX_UPLOAD:
        raise ValueError("图片超过 20 MB")
    try:
        image = Image.open(BytesIO(raw))
        if image.width * image.height > Image.MAX_IMAGE_PIXELS:
            raise ValueError("图片不能超过 2500 万像素")
        image.verify()
        image = Image.open(BytesIO(raw))
        if image.format not in ("JPEG", "PNG", "WEBP"):
            raise ValueError("仅支持 JPEG、PNG、WebP")
        image = ImageOps.exif_transpose(image)
        image.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("无效或过大的图片") from exc
    if min(image.size) < 256:
        raise ValueError("图片宽高均需至少 256 像素")
    return image.convert("RGBA" if "A" in image.getbands() else "RGB")


def prepare(image: Image.Image, bbox: tuple[float, float, float, float], remove_bg: bool = False) -> bytes:
    x1, y1, x2, y2 = bbox
    if not (0 <= x1 < x2 <= 1 and 0 <= y1 < y2 <= 1):
        raise ValueError("bbox 必须为归一化的 [x1,y1,x2,y2]")
    w, h = image.size
    # A small margin keeps thin projections (handles, ears, legs) intact.
    mx, my = (x2 - x1) * .08, (y2 - y1) * .08
    box = (max(0, int((x1 - mx) * w)), max(0, int((y1 - my) * h)),
           min(w, int((x2 + mx) * w)), min(h, int((y2 + my) * h)))
    subject = image.crop(box)
    subject.thumbnail((1536, 1536), Image.Resampling.LANCZOS)
    if remove_bg:
        try:
            from rembg import remove
        except ImportError as exc:
            raise ValueError('抠图需要安装 pip install "rembg[cpu]"') from exc
        subject = remove(subject).convert("RGBA")
    side = max(512, int(max(subject.size) / .82))
    canvas = Image.new("RGBA" if subject.mode == "RGBA" else "RGB", (side, side),
                       (245, 245, 245, 0) if subject.mode == "RGBA" else (245, 245, 245))
    canvas.paste(subject, ((side - subject.width)//2, (side - subject.height)//2))
    out = BytesIO()
    canvas.save(out, "PNG", optimize=True)
    if out.tell() > MAX_UPLOAD:
        raise ValueError("预处理结果超过 20 MB")
    return out.getvalue()


def prepare_environment(image: Image.Image) -> bytes:
    """Keep a room photo's field of view and aspect ratio intact."""
    scene = image.copy().convert("RGB")
    scene.thumbnail((1536, 1536), Image.Resampling.LANCZOS)
    out = BytesIO()
    scene.save(out, "PNG", optimize=True)
    if out.tell() > MAX_UPLOAD:
        raise ValueError("预处理结果超过 20 MB")
    return out.getvalue()
