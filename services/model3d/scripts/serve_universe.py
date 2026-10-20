"""Local entry point: python -m scripts.serve_universe (single worker)."""
import os
from pathlib import Path
from dotenv import load_dotenv


def main():
    root = Path(__file__).resolve().parents[1]
    load_dotenv(root / ".env", override=False)
    data = Path(os.getenv("DATA_DIR") or "data")
    os.environ["DATA_DIR"] = str(data if data.is_absolute() else root / data)
    import uvicorn
    uvicorn.run("app.main:app", host="127.0.0.1", port=int(os.getenv("PORT", "8000")), workers=1)


if __name__ == "__main__":
    main()
