"use client";

import { Download, Image as ImageIcon, Share2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Item } from "@/lib/types";
import { CATEGORY_LABELS } from "@/lib/types";
import { formatDate } from "@/lib/format";

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1920;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("照片加载失败"));
    image.src = src;
  });
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  const contextWithRoundRect = context as CanvasRenderingContext2D & {
    roundRect?: (
      x: number,
      y: number,
      width: number,
      height: number,
      radii: number,
    ) => void;
  };
  if (typeof contextWithRoundRect.roundRect === "function") {
    contextWithRoundRect.roundRect(x, y, width, height, radius);
    return;
  }
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
}

async function renderShareCard(item: Item): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法生成分享图");

  context.fillStyle = "#F4F7F6";
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  context.fillStyle = "#1B2A28";
  context.font = "700 54px Arial, PingFang SC, sans-serif";
  context.fillText("遇见集", 84, 120);
  context.fillStyle = "#7C8A86";
  context.font = "28px Arial, PingFang SC, sans-serif";
  context.fillText("遇见世界，收藏第一次", 84, 168);

  const image = await loadImage(item.photo);
  const imageX = 84;
  const imageY = 270;
  const imageWidth = CARD_WIDTH - 168;
  const imageHeight = 860;
  const imageRatio = image.width / image.height;
  const boxRatio = imageWidth / imageHeight;
  const sourceWidth = imageRatio > boxRatio ? image.height * boxRatio : image.width;
  const sourceHeight = imageRatio > boxRatio ? image.height : image.width / boxRatio;
  const sourceX = (image.width - sourceWidth) / 2;
  const sourceY = (image.height - sourceHeight) / 2;
  context.save();
  roundedRect(context, imageX, imageY, imageWidth, imageHeight, 38);
  context.clip();
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    imageX,
    imageY,
    imageWidth,
    imageHeight,
  );
  context.restore();

  context.fillStyle = "#1B2A28";
  context.font = "700 62px Arial, PingFang SC, sans-serif";
  context.fillText(item.name.slice(0, 16), 84, 1270);
  context.fillStyle = "#6C7D79";
  context.font = "30px Arial, PingFang SC, sans-serif";
  context.fillText(`${item.place} · ${formatDate(item.date)}`, 84, 1330);
  context.fillStyle = "#2F6F6A";
  context.font = "700 28px Arial, PingFang SC, sans-serif";
  context.fillText(CATEGORY_LABELS[item.category], 84, 1400);

  if (item.ai) {
    context.fillStyle = "#33403D";
    context.font = "32px Arial, PingFang SC, sans-serif";
    const line = item.ai.memorySentence.slice(0, 32);
    context.fillText(`“${line}”`, 84, 1500);
    context.fillStyle = "#82908F";
    context.font = "24px Arial, PingFang SC, sans-serif";
    context.fillText("AI 生成，未经核实", 84, 1585);
  } else {
    context.fillStyle = "#82908F";
    context.font = "30px Arial, PingFang SC, sans-serif";
    context.fillText("这件遇见还没有显影", 84, 1500);
  }

  context.fillStyle = "#A0AEAA";
  context.font = "24px Arial, PingFang SC, sans-serif";
  context.fillText("YU JIAN JI", 84, 1800);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("分享图导出失败"));
    }, "image/png");
  });
}

export function ShareCard({ item }: { item: Item }) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const fileName = useMemo(
    () => `yujianji-${item.id.slice(0, 18)}.png`,
    [item.id],
  );

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function generate() {
    setBusy(true);
    setStatus("");
    try {
      const nextBlob = await renderShareCard(item);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setBlob(nextBlob);
      setPreviewUrl(URL.createObjectURL(nextBlob));
      setStatus("分享图已生成，可保存到相册");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "分享图生成失败");
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
      setStatus("如果没有自动保存，请点开预览后长按图片保存到相册");
    }
  }

  async function share() {
    if (!blob) return;
    if (!navigator.share) {
      download();
      return;
    }
    const file = new File([blob], fileName, { type: "image/png" });
    try {
      if (!navigator.canShare || !navigator.canShare({ files: [file] })) {
        download();
        return;
      }
      await navigator.share({ title: item.name, files: [file] });
    } catch {
      setStatus("已取消分享，仍可以下载图片");
    }
  }

  return (
    <section className="share-card-panel surface">
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">带走这一刻</p>
          <h2>生成分享图</h2>
        </div>
        <ImageIcon size={18} color="var(--teal)" />
      </div>
      {previewUrl ? (
        <div className="share-preview">
          <img src={previewUrl} alt={`${item.name} 分享图预览`} />
        </div>
      ) : (
        <p className="share-copy">把这件遇见做成一张 1080 × 1920 的长图，存进相册或发给朋友。</p>
      )}
      <div className="action-row share-actions">
        <button className="secondary-action" onClick={() => void generate()} disabled={busy}>
          <ImageIcon size={16} />
          {busy ? "正在生成…" : blob ? "重新生成" : "生成分享图"}
        </button>
        {blob ? (
          <>
            <button className="secondary-action" onClick={download}>
              <Download size={16} />
              保存
            </button>
            <button className="secondary-action" onClick={() => void share()}>
              <Share2 size={16} />
              分享
            </button>
          </>
        ) : null}
      </div>
      {status ? <p className="share-status">{status}</p> : null}
    </section>
  );
}
