#!/bin/sh
# Tripo 原始 GLB（几十 MB、上百万面）→ 前端 GLB（约 0.5–1 MB）：减面到约 4%、meshopt 压缩、贴图 512 WebP。
# 用法：sh scripts/demo-3d/optimize.sh [缓存目录]，默认 ../demo-3d-cache；输出到 public/assets/models/demo/<id 去掉 demo- 前缀>.glb
set -e
CACHE="${1:-$(dirname "$0")/../../../demo-3d-cache}"
OUT="$(dirname "$0")/../../public/assets/models/demo"
mkdir -p "$OUT"
for raw in "$CACHE"/*-raw.glb; do
  id=$(basename "$raw" -raw.glb)
  slug=${id#demo-}
  if [ -f "$OUT/$slug.glb" ] && [ "$OUT/$slug.glb" -nt "$raw" ]; then continue; fi
  npx -y @gltf-transform/cli@4 optimize "$raw" "$OUT/$slug.glb" --compress meshopt --simplify-ratio 0.04 --simplify-error 0.01 --texture-compress webp --texture-size 512 > /dev/null
  echo "$slug $(wc -c < "$OUT/$slug.glb" | tr -d ' ') bytes"
done
