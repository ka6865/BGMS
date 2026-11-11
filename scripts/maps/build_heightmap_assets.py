"""3D 리플레이·박격포용 지형 하이트맵과 건물 사각형을 만든다.

입력: 건물 높이가 섞인 16비트 하이트맵 PNG(값 32768 = 0m, 64 = 1m)와 건물이 없는 기존 8비트 지형 하이트맵.
출력: public/assets/map/{Map}_HeightMap.png(건물을 뺀 지형, 128 = 0m, 한 단계 2m)
      public/assets/map/{Map}_Buildings.json(건물 중심·폭·길이·회전·높이, 맵 8192 좌표)

필요 패키지: numpy, scipy, opencv-python, pillow
사용: python3 scripts/maps/build_heightmap_assets.py <16비트 PNG> <기준 8비트 지형> <맵 이름> <출력 폴더>
기준 지형은 건물 판별에만 쓴다. 입력 16비트 PNG의 값 65535 영역(가장자리 표식)은 지형으로 메운다.
"""
import json
import sys

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage

Image.MAX_IMAGE_PIXELS = None

# 기준 지형보다 이만큼(m) 높은 덩어리를 건물로 본다.
BUILDING_MIN_RISE_M = 3
BUILDING_MIN_AREA_PX = 12
BUILDING_MAX_AREA_PX = 40_000
BUILDING_MIN_HEIGHT_M = 2.5
# 지붕은 평면이라 곡률(라플라시안 평균)이 작다. 바위 지대는 3 이상으로 커서 이 값을 넘으면 뺀다.
BUILDING_MAX_ROUGHNESS = 2.0
# 큰 덩어리가 사각형과 너무 다르면(고가도로, 경기장 고리) 상자 하나로 그리면 틀리므로 뺀다.
# 건물 벽은 수직이라 가장자리 기울기(m/px)가 높이에 비해 크다. 절벽·언덕 오탐은 0.2 아래로 완만하다.
BUILDING_MIN_EDGE_SHARPNESS = 0.25
LARGE_BUILDING_AREA_PX = 3000
LARGE_BUILDING_MIN_FILL = 0.65


def fill_from_nearest(source: np.ndarray, area: np.ndarray) -> np.ndarray:
    """area(와 경계 2px) 자리를 가장 가까운 바깥 값으로 메운다."""
    fill = ndimage.binary_dilation(area, iterations=2)
    nearest = ndimage.distance_transform_edt(fill, return_distances=False, return_indices=True)
    return source[nearest[0], nearest[1]]


def main(source_path: str, reference_path: str, map_name: str, out_dir: str) -> None:
    source = np.array(Image.open(source_path)).astype(np.float64)
    reference = np.array(Image.open(reference_path).convert("L")).astype(np.float64)
    marker = source == 65535
    source_m = (source - 32768) / 64

    # 기준 지형의 높이 배율이 달라도 맞도록 선형으로 맞춘 뒤 차이를 본다.
    sample = (slice(None, None, 9), slice(None, None, 9))
    keep = ~marker[sample].ravel()
    design = np.vstack([reference[sample].ravel(), np.ones(reference[sample].size)]).T
    scale, offset = np.linalg.lstsq(design[keep], source_m[sample].ravel()[keep], rcond=None)[0]
    rise = source_m - (scale * reference + offset)

    mask = ndimage.binary_opening((rise > BUILDING_MIN_RISE_M) & ~marker, iterations=1)
    labels, count = ndimage.label(mask)
    sizes = ndimage.sum(mask, labels, range(1, count + 1))
    accepted = np.zeros(count + 1, bool)
    accepted[1:] = (sizes >= BUILDING_MIN_AREA_PX) & (sizes <= BUILDING_MAX_AREA_PX)
    mask = accepted[labels]

    # 후보 자리를 메운 임시 지형으로 높이를 재고, 최종 건물만 골라 다시 메운다.
    # 후보였다가 빠진 바위·절벽은 지형이므로 저장할 지형에서 깎이면 안 된다.
    terrain = fill_from_nearest(source, mask | marker)
    height_m = (source - terrain) / 64
    curvature = np.abs(ndimage.laplace(source_m))
    gradient = np.hypot(*np.gradient(source_m))
    interior = ndimage.binary_erosion(mask, iterations=1)
    labels, _ = ndimage.label(mask)
    buildings = []
    building_mask = np.zeros_like(mask)
    for index, region in enumerate(ndimage.find_objects(labels), 1):
        inside = labels[region] == index
        core = inside & interior[region]
        roughness = float(curvature[region][core].mean()) if core.any() else 0.0
        ys, xs = np.nonzero(inside)
        points = np.stack([xs + region[1].start, ys + region[0].start], 1).astype(np.float32)
        (cx, cy), (width, length), angle = cv2.minAreaRect(points)
        area = int(inside.sum())
        fill = area / ((width + 1) * (length + 1))
        height = float(np.percentile(height_m[region][inside], 80))
        edge = inside & ~ndimage.binary_erosion(inside)
        sharpness = float(np.median(gradient[region][edge])) / max(height, 0.1)
        if height < BUILDING_MIN_HEIGHT_M or width < 2 or length < 2 or roughness > BUILDING_MAX_ROUGHNESS:
            continue
        if sharpness < BUILDING_MIN_EDGE_SHARPNESS:
            continue
        if area > LARGE_BUILDING_AREA_PX and fill < LARGE_BUILDING_MIN_FILL:
            continue
        building_mask[region] |= inside
        buildings.append([round(cx, 1), round(cy, 1), round(width + 1, 1), round(length + 1, 1), round(angle, 1), round(height, 1)])

    terrain = fill_from_nearest(source, building_mask | marker)
    levels = np.clip(np.rint((terrain - 32768) / 128) + 128, 0, 255).astype(np.uint8)
    Image.fromarray(levels, "L").save(f"{out_dir}/{map_name}_HeightMap.png", optimize=True)

    with open(f"{out_dir}/{map_name}_Buildings.json", "w") as file:
        json.dump(
            {"version": 1, "fields": ["x", "y", "width", "length", "angleDeg", "heightM"], "buildings": buildings},
            file,
            separators=(",", ":"),
        )
    print(f"{map_name}: buildings={len(buildings)} scale={scale:.4f} offset={offset:.2f}")


if __name__ == "__main__":
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    main(*sys.argv[1:])
