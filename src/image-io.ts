import { rgbaToGray } from "./core";
import type { SourceImage } from "./core/types";
import { assertScreenshotOrientation } from "../shared/image-metadata";

export async function decodeSource(source: SourceImage): Promise<Uint8Array> {
  const { gray, width, height } = await decodeDataUrl(source.dataUrl);
  if (width !== source.width || height !== source.height)
    throw new Error("图片实际尺寸与分析文件不符。");
  if ((await imageHash(source.dataUrl)) !== source.sha256)
    throw new Error("图片校验失败：图像内容与保存的哈希不符。");
  return gray;
}

export async function imageHash(dataUrl: string): Promise<string> {
  const bytes = Uint8Array.from(atob(dataUrl.split(",")[1]), (c) =>
    c.charCodeAt(0),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export async function loadScreenshot(
  file: File,
): Promise<{ source: SourceImage; gray: Uint8Array }> {
  if (!["image/png", "image/jpeg"].includes(file.type))
    throw new Error("请选择 PNG 或 JPEG 截图。");
  if (file.size > 15 * 1024 * 1024)
    throw new Error("截图超过 15 MB，请先截取需要分析的单个面板。");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取文件。"));
    reader.readAsDataURL(file);
  });
  const { gray, width, height } = await decodeDataUrl(dataUrl);
  const source = {
    name: file.name || "clipboard.png",
    dataUrl,
    width,
    height,
    sha256: await imageHash(dataUrl),
  };
  return { source, gray };
}

/** Decode an original screenshot consistently for measurement and AI input crops. */
export async function decodeScreenshotImage(dataUrl: string): Promise<HTMLImageElement> {
  if (
    !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(dataUrl) ||
    dataUrl.length > 22 * 1024 * 1024
  )
    throw new Error("不支持的图片数据。");
  if (dataUrl.startsWith("data:image/jpeg;")) {
    assertScreenshotOrientation(
      Uint8Array.from(atob(dataUrl.split(",")[1]), (c) => c.charCodeAt(0)),
    );
  }
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("图片解码失败。"));
    img.src = dataUrl;
  });
  if (img.naturalWidth > 16000 || img.naturalHeight > 16000)
    throw new Error("截图单边超过 16000 像素，请先截取单个面板。");
  if (img.naturalWidth * img.naturalHeight > 20_000_000)
    throw new Error("截图超过 2000 万像素，请先截取单个面板。");
  return img;
}

async function decodeDataUrl(dataUrl: string) {
  const img = await decodeScreenshotImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("当前浏览器无法读取图片像素。");
  context.drawImage(img, 0, 0);
  const gray = rgbaToGray(
    context.getImageData(0, 0, canvas.width, canvas.height).data,
  );
  return { gray, width: canvas.width, height: canvas.height };
}
