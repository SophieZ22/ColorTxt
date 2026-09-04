// sophie 
import { app } from "electron";
import path from "node:path";
import { readFile } from "node:fs/promises";
import * as ort from "onnxruntime-node";

import {
  Image,
  RecognitionService,
  getTextRecognitionPreset,
  getTextRecognitionPresetOptions,
  type OrtInferenceSession,
  type OrtModule,
} from "paddleocr";

let recognitionServicePromise: Promise<RecognitionService> | null = null;

/*
 * 测试阶段先关闭缓存。
 *
 * 等我们确认“做”等几个已知字符都识别正确以后，
 * 再改成 true。
 */
const ENABLE_OCR_CACHE = true;

const ocrCache = new Map<string, string | null>();

/*
 * PP-OCR 返回的 confidence 通常为 0~1。
 */
const MIN_HAN_CONFIDENCE = 0.4;
const MIN_OTHER_CONFIDENCE = 0.55;

/**
 * 开发环境：
 *
 *   <project>/resources/ocr/ppocr_v5_mobile
 *
 * 打包后：
 *
 *   <resources>/ocr/ppocr_v5_mobile
 */
function getOcrModelDirectory(): string {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      "ocr",
      "ppocr_v5_mobile",
    );
  }

  return path.join(
    app.getAppPath(),
    "resources",
    "ocr",
    "ppocr_v5_mobile",
  );
}

/**
 * 为 PP-OCRv5 创建全局唯一 RecognitionService。
 *
 * 模型只加载一次。
 */
async function getRecognitionService(): Promise<RecognitionService> {
  if (!recognitionServicePromise) {
    recognitionServicePromise = (async () => {
      const directory =
        getOcrModelDirectory();

      const modelPath = path.join(
        directory,
        "PP-OCRv5_mobile_rec_infer.onnx",
      );

      const dictionaryPath = path.join(
        directory,
        "ppocrv5_dict.txt",
      );

      console.log(
        "[inline-ocr] loading PP-OCRv5 model:",
        modelPath,
      );

      /*
       * 读取 PP-OCRv5 字典。
       */
      const dictionaryText = await readFile(
        dictionaryPath,
        "utf8",
      );

      let charactersDictionary =
        dictionaryText
          .replace(/\r/g, "")
          .split("\n");

      /*
       * 文件最后通常带换行，
       * 删除最后那个真正的空字符串。
       *
       * 注意：
       * 不要 trim 整个 dictionaryText，
       * 因为字典可能包含空格字符。
       */
      if (
        charactersDictionary.length > 0 &&
        charactersDictionary[
          charactersDictionary.length - 1
        ] === ""
      ) {
        charactersDictionary.pop();
      }

      const preset =
        getTextRecognitionPreset(
          "PP-OCRv5_mobile_rec",
        );

      /*
       * PaddleOCR 的字典允许把 space
       * 作为最后一个额外字符。
       */
      if (
        preset.dictionary.useSpaceChar &&
        charactersDictionary.length ===
          preset.dictionary.dictionaryLength - 1
      ) {
        charactersDictionary.push(" ");
      }

      if (
        charactersDictionary.length !==
        preset.dictionary.dictionaryLength
      ) {
        throw new Error(
          [
            "PP-OCRv5 dictionary length mismatch",
            `actual=${charactersDictionary.length}`,
            `expected=${preset.dictionary.dictionaryLength}`,
            `file=${dictionaryPath}`,
          ].join(", "),
        );
      }

      /*
       * 只用 CPU。
       *
       * 这种几十像素的小图片没有必要启动 GPU。
       */
      const session =
        await ort.InferenceSession.create(
          modelPath,
          {
            executionProviders: ["cpu"],
          },
        );

      const service =
        new RecognitionService(
          ort as unknown as OrtModule,
          session as unknown as OrtInferenceSession,
          {
            ...getTextRecognitionPresetOptions(
              "PP-OCRv5_mobile_rec",
            ),

            charactersDictionary,
          },
        );

      console.log(
        "[inline-ocr] PP-OCRv5 ready:",
        {
          dictionaryLength:
            charactersDictionary.length,

          imageHeight:
            preset.options.imageHeight,

          imageWidth:
            preset.options.imageWidth,
        },
      );

      return service;
    })();
  }

  return recognitionServicePromise;
}

/**
 * 仅用于日志。
 *
 * Windows PowerShell 当前存在中文编码显示问题，
 * 所以日志统一打印 Unicode code point。
 */
function toUnicodeEscapes(
  text: string,
): string {
  return Array.from(text)
    .map((character) => {
      const code =
        character.codePointAt(0)!;

      return (
        "U+" +
        code
          .toString(16)
          .toUpperCase()
          .padStart(4, "0")
      );
    })
    .join(" ");
}

/**
 * Electron NativeImage
 * →
 * paddleocr.Image
 *
 * 这里与之前 Tesseract 预处理最大的区别：
 *
 * 不二值化
 * 不 7× 最近邻放大
 *
 * PP-OCR 自己会按照模型要求 resize 到高度 48。
 *
 * 我们这里只做：
 *
 * 1. 透明背景合成到白色
 * 2. 判断是否白底/黑底
 * 3. 自动反色成“深色字 + 浅色背景”
 * 4. 裁掉大块无效边缘
 * 5. 加一点白边
 */
function prepareRecognitionImage(
  native: Electron.NativeImage,
): Image {
  const { width, height } =
    native.getSize();

  const bitmap = native.toBitmap({
    scaleFactor: 1,
  });

  if (
    width <= 0 ||
    height <= 0 ||
    bitmap.length <
      width * height * 4
  ) {
    throw new Error(
      `Invalid native image: ${width}x${height}, bytes=${bitmap.length}`,
    );
  }

  const gray =
    new Uint8Array(
      width * height,
    );

  /*
   * Electron bitmap 每像素 4 byte。
   *
   * 不依赖 RGB / BGR 顺序：
   * 因为直接取前三个颜色通道平均值。
   */
  for (
    let i = 0;
    i < width * height;
    i++
  ) {
    const offset = i * 4;

    const c1 = bitmap[offset];
    const c2 = bitmap[offset + 1];
    const c3 = bitmap[offset + 2];
    const alpha = bitmap[offset + 3];

    const rawGray =
      (c1 + c2 + c3) / 3;

    /*
     * 透明区域合成到白色。
     */
    gray[i] = Math.round(
      255 -
        (255 - rawGray) *
          (alpha / 255),
    );
  }

  /*
   * 用图片边界估算背景亮度。
   *
   * 图片字通常：
   *
   * 白背景 + 黑字
   *
   * 但这里同时兼容：
   *
   * 黑背景 + 白字
   */
  let borderSum = 0;
  let borderCount = 0;

  const addBorderPixel = (
    x: number,
    y: number,
  ) => {
    borderSum +=
      gray[y * width + x];

    borderCount++;
  };

  for (
    let x = 0;
    x < width;
    x++
  ) {
    addBorderPixel(x, 0);

    if (height > 1) {
      addBorderPixel(
        x,
        height - 1,
      );
    }
  }

  for (
    let y = 1;
    y < height - 1;
    y++
  ) {
    addBorderPixel(0, y);

    if (width > 1) {
      addBorderPixel(
        width - 1,
        y,
      );
    }
  }

  const backgroundGray =
    borderCount > 0
      ? borderSum / borderCount
      : 255;

  const invert =
    backgroundGray < 128;

  /*
   * 统一成：
   *
   * 白背景
   * 深色文字
   */
  if (invert) {
    for (
      let i = 0;
      i < gray.length;
      i++
    ) {
      gray[i] =
        255 - gray[i];
    }
  }

  const normalizedBackground =
    invert
      ? 255 - backgroundGray
      : backgroundGray;

  /*
   * 和背景相差至少约 20 灰度，
   * 才认为可能属于文字。
   */
  const foregroundThreshold =
    Math.max(
      0,
      normalizedBackground - 20,
    );

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (
    let y = 0;
    y < height;
    y++
  ) {
    for (
      let x = 0;
      x < width;
      x++
    ) {
      const value =
        gray[y * width + x];

      if (
        value <
        foregroundThreshold
      ) {
        minX = Math.min(
          minX,
          x,
        );

        maxX = Math.max(
          maxX,
          x,
        );

        minY = Math.min(
          minY,
          y,
        );

        maxY = Math.max(
          maxY,
          y,
        );
      }
    }
  }

  /*
   * 如果没找到明显文字，
   * 使用整张图。
   */
  if (
    maxX < minX ||
    maxY < minY
  ) {
    minX = 0;
    minY = 0;
    maxX = width - 1;
    maxY = height - 1;
  }

  /*
   * 给裁剪区域额外保留 1 个
   * 原始像素，避免把笔画边缘截掉。
   */
  minX = Math.max(
    0,
    minX - 1,
  );

  minY = Math.max(
    0,
    minY - 1,
  );

  maxX = Math.min(
    width - 1,
    maxX + 1,
  );

  maxY = Math.min(
    height - 1,
    maxY + 1,
  );

  const cropWidth =
    maxX - minX + 1;

  const cropHeight =
    maxY - minY + 1;

  /*
   * PP-OCR 输入高度最终会变成 48。
   *
   * 加 4px 原始白边即可，
   * 不需要像 Tesseract 那样放大到 200px。
   */
  const padding = 4;

  const outputWidth =
    cropWidth +
    padding * 2;

  const outputHeight =
    cropHeight +
    padding * 2;

  const rgb =
    new Uint8Array(
      outputWidth *
        outputHeight *
        3,
    );

  rgb.fill(255);

  for (
    let y = 0;
    y < cropHeight;
    y++
  ) {
    for (
      let x = 0;
      x < cropWidth;
      x++
    ) {
      const sourceX =
        minX + x;

      const sourceY =
        minY + y;

      const value =
        gray[
          sourceY * width +
            sourceX
        ];

      const destinationX =
        x + padding;

      const destinationY =
        y + padding;

      const destinationOffset =
        (
          destinationY *
            outputWidth +
          destinationX
        ) * 3;

      /*
       * 灰度图复制到 RGB。
       *
       * 因为 R=G=B，
       * PP-OCR preset 使用 BGR 也不受影响。
       */
      rgb[
        destinationOffset
      ] = value;

      rgb[
        destinationOffset + 1
      ] = value;

      rgb[
        destinationOffset + 2
      ] = value;
    }
  }

  console.log(
    "[inline-ocr] prepare:",
    {
      original:
        `${width}x${height}`,

      crop:
        `${cropWidth}x${cropHeight}`,

      output:
        `${outputWidth}x${outputHeight}`,

      backgroundGray:
        Math.round(
          backgroundGray,
        ),

      inverted:
        invert,
    },
  );

  return new Image(
    outputWidth,
    outputHeight,
    3,
    rgb,
  );
}

/**
 * 只有真正得到一个字符时，
 * 才允许写进正文。
 */
function normalizeSingleCharacter(
  text: string,
): string | null {
  const cleaned =
    text.trim();

  if (!cleaned) {
    return null;
  }

  const characters =
    Array.from(cleaned);

  if (
    characters.length !== 1
  ) {
    return null;
  }

  const character =
    characters[0];

  if (
    !/^[\p{Script=Han}\p{L}\p{N}，。！？、；：”“‘’（）《》〈〉…—\-]$/u.test(
      character,
    )
  ) {
    return null;
  }

  return character;
}
function prepareRecognitionImageWithoutCrop(
  native: Electron.NativeImage,
): Image {
  const { width, height } = native.getSize();

  const bitmap = native.toBitmap({
    scaleFactor: 1,
  });

  const padding = 6;

  const outputWidth = width + padding * 2;
  const outputHeight = height + padding * 2;

  const rgb = new Uint8Array(
    outputWidth * outputHeight * 3,
  );

  // 白色背景
  rgb.fill(255);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceOffset =
        (y * width + x) * 4;

      const c1 = bitmap[sourceOffset];
      const c2 = bitmap[sourceOffset + 1];
      const c3 = bitmap[sourceOffset + 2];
      const alpha = bitmap[sourceOffset + 3] / 255;

      // 转灰度，并把透明背景合成到白色
      const rawGray =
        (c1 + c2 + c3) / 3;

      const gray = Math.round(
        255 - (255 - rawGray) * alpha,
      );

      const destinationOffset =
        (
          (y + padding) * outputWidth +
          (x + padding)
        ) * 3;

      rgb[destinationOffset] = gray;
      rgb[destinationOffset + 1] = gray;
      rgb[destinationOffset + 2] = gray;
    }
  }

  console.log("[inline-ocr] fallback prepare:", {
    original: `${width}x${height}`,
    output: `${outputWidth}x${outputHeight}`,
  });

  return new Image(
    outputWidth,
    outputHeight,
    3,
    rgb,
  );
}
/**
 * OCR 一个疑似“图片字”。
 */
export async function recognizeInlineCharacter(
  imageUrl: string,
  nativeImage: Electron.NativeImage,
): Promise<string | null> {
  if (ENABLE_OCR_CACHE) {
    const cached = ocrCache.get(imageUrl);

    if (cached) {
        console.log(
        "[inline-ocr] cache hit:",
        imageUrl,
        );

        return cached;
    }
  }

  try {
    const service =
      await getRecognitionService();

    function getMinOcrConfidence(
      character: string,
    ): number {
      if (/^\p{Script=Han}$/u.test(character)) {
        return MIN_HAN_CONFIDENCE;
      }

      return MIN_OTHER_CONFIDENCE;
    }

    async function runRecognition(
      image: Image,
    ) {
      const results = await service.run(
        image,
        [
          {
            x: 0,
            y: 0,
            width: image.width,
            height: image.height,
          },
        ],
      );

      return results[0] ?? null;
    }

    // 第一遍：裁剪 + 白边预处理
    const primaryImage =
      prepareRecognitionImage(nativeImage);

    let result =
      await runRecognition(primaryImage);

    let character = result
      ? normalizeSingleCharacter(result.text)
      : null;

    /*
     * 第一遍没有有效单字符，或者置信度太低时，
     * 再使用“不裁剪”的图片识别一次。
     */
    const primaryMinConfidence =
      character
        ? getMinOcrConfidence(character)
        : Infinity;

    if (
      !result ||
      !character ||
      result.confidence < primaryMinConfidence
    ) {
      const fallbackImage =
        prepareRecognitionImageWithoutCrop(
          nativeImage,
        );

      const fallbackResult =
        await runRecognition(fallbackImage);

      if (fallbackResult) {
        const fallbackCharacter =
          normalizeSingleCharacter(
            fallbackResult.text,
          );

        console.log(
          "[inline-ocr] fallback result:",
          {
            url: imageUrl,
            textCodePoints:
              toUnicodeEscapes(
                fallbackResult.text,
              ),
            characterCodePoint:
              fallbackCharacter
                ? toUnicodeEscapes(
                    fallbackCharacter,
                  )
                : null,
            confidence: Number(
              fallbackResult.confidence.toFixed(4),
            ),
          },
        );

        if (fallbackCharacter) {
          const fallbackMinConfidence =
            getMinOcrConfidence(
              fallbackCharacter,
            );

          if (
            fallbackResult.confidence >=
              fallbackMinConfidence &&
            (
              !result ||
              !character ||
              fallbackResult.confidence >
                result.confidence
            )
          ) {
            result = fallbackResult;
            character = fallbackCharacter;
          }
        }
      }
    }

    // 两次都没有结果
    if (!result || !character) {
      console.warn(
        "[inline-ocr] no valid character:",
        imageUrl,
      );


      return null;
    }

    console.log(
      "[inline-ocr] result:",
      {
        url: imageUrl,

        textCodePoints:
          toUnicodeEscapes(result.text),

        characterCodePoint:
          toUnicodeEscapes(character),

        confidence: Number(
          result.confidence.toFixed(4),
        ),
      },
    );

    const minConfidence =
      getMinOcrConfidence(character);

    if (
      result.confidence <
      minConfidence
    ) {
      console.warn(
        "[inline-ocr] rejected:",
        {
          url: imageUrl,

          textCodePoints:
            toUnicodeEscapes(
              result.text,
            ),

          characterCodePoint:
            toUnicodeEscapes(
              character,
            ),

          confidence:
            result.confidence,

          minConfidence,
        },
      );


      return null;
    }

    // OCR 成功
    if (ENABLE_OCR_CACHE) {
      ocrCache.set(
        imageUrl,
        character,
      );
    }

    return character;
  } catch (error) {
    console.warn(
      "[inline-ocr] failed:",
      imageUrl,
      error,
    );


    return null;
  }
}