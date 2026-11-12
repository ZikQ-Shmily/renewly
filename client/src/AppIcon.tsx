import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { AppWindow, ImagePlus } from "lucide-react";
import { Select } from "./Select";

import { appIconInitial, appIconPresets, merchantIconPresets, matchedAppIcon, isUploadedAppIcon, maxUploadBytes, resolveAppIcon } from "./app-icons";

interface AppIconProps {
  name: string;
  website: string;
  value?: string;
  size?: number;
  fallbackInitial?: boolean;
}

export function AppIcon({ name, website, value = "auto", size = 36, fallbackInitial = false }: AppIconProps) {
  const { preset, src } = resolveAppIcon(name, website, value);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const brand = preset?.image;
  const primarySource = brand?.light || src;
  const themeVariant = brand && brand.dark !== brand.light;
  const imageSize = Math.max(16, Math.round(size * (brand ? 0.78 : 0.62)));
  const frameStyle: CSSProperties = { width: size, height: size, flexShrink: 0 };
  return (
    <span className={`app-icon${brand ? " app-icon-brand" : ""}${themeVariant ? " app-icon-brand-themed" : ""}`} style={frameStyle} aria-hidden="true">
      {primarySource && primarySource !== failedSource ? (
        <>
          <img key={primarySource} className={`app-icon-image${themeVariant ? " app-icon-brand-light" : ""}`}
            src={primarySource} width={imageSize} height={imageSize} alt=""
            referrerPolicy="no-referrer" crossOrigin="anonymous" loading="lazy" decoding="async"
            onError={() => setFailedSource(primarySource)} />
          {themeVariant && <img key={brand.dark} className="app-icon-image app-icon-brand-dark"
            src={brand.dark} width={imageSize} height={imageSize} alt=""
            referrerPolicy="no-referrer" crossOrigin="anonymous" loading="lazy" decoding="async"
            onError={() => setFailedSource(primarySource)} />}
        </>
      ) : preset && !brand ? (
        <span className="app-icon-preset" style={{
          width: imageSize,
          height: imageSize,
          backgroundColor: preset.color,
          maskImage: `url(/app-icons/${preset.key}.svg)`,
          WebkitMaskImage: `url(/app-icons/${preset.key}.svg)`,
          maskSize: "contain",
          WebkitMaskSize: "contain",
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          maskPosition: "center",
          WebkitMaskPosition: "center",
        }} />
      ) : fallbackInitial ? <span className="app-icon-initial">{appIconInitial(name)}</span> : <AppWindow size={imageSize} aria-hidden="true" />}
    </span>
  );
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("图片读取失败，请重新选择。"));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图片读取失败。"));
    reader.readAsDataURL(file);
  });
}

async function validateImage(data: string) {
  await new Promise<void>((resolve, reject) => {
    const image = new Image();
    image.onload = () => image.naturalWidth > 0 && image.naturalHeight > 0 && image.naturalWidth <= 2048 && image.naturalHeight <= 2048
      ? resolve()
      : reject(new Error("图标尺寸需在 1～2048 像素之间。"));
    image.onerror = () => reject(new Error("图片无法解析，请选择有效的 PNG、JPEG 或 WebP 图片。"));
    image.src = data;
  });
}

interface AppIconPickerProps extends Omit<AppIconProps, "size" | "value"> {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}

export function AppIconPicker({ name, website, value, onChange, disabled = false, label = "订阅图标", fallbackInitial = false }: AppIconPickerProps) {
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const request = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current++; };
  }, []);
  const uploaded = isUploadedAppIcon(value);
  const preset = matchedAppIcon(name, website);
  const selectedValue = uploaded ? "uploaded" : value || "auto";
  const options = [
    { value: "auto", label: "自动匹配" },
    { value: "generic", label: fallbackInitial ? "商家首字母" : "通用订阅图标" },
    ...(fallbackInitial ? merchantIconPresets : appIconPresets).map(p => ({ value: p.key, label: p.label })),
    ...((fallbackInitial ? appIconPresets : merchantIconPresets).filter(p => p.key === value).map(p => ({ value: p.key, label: p.label }))),
    ...(uploaded ? [{ value: "uploaded", label: "已上传的图标" }] : []),
  ];
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const generation = ++request.current;
    setError("");
    try {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
        throw new Error("仅支持 PNG、JPEG 或 WebP 图片。");
      if (!file.size || file.size > maxUploadBytes)
        throw new Error("图标文件需小于或等于 64 KB。");
      setReading(true);
      const data = await readFile(file);
      if (!isUploadedAppIcon(data)) throw new Error("图标格式无效或文件过大。");
      await validateImage(data);
      if (mounted.current && generation === request.current) onChange(data);
    } catch (cause) {
      if (mounted.current && generation === request.current)
        setError(cause instanceof Error ? cause.message : "图标读取失败。");
    } finally {
      if (mounted.current && generation === request.current) setReading(false);
    }
  }
  return (
    <div className="app-icon-picker">
      <div className="app-icon-picker-label">{label}</div>
      <div className="app-icon-picker-controls">
        <AppIcon name={name} website={website} value={value} size={42} fallbackInitial={fallbackInitial} />
        <Select value={selectedValue} options={options} onValueChange={next => {
          request.current++;
          setReading(false);
          setError("");
          if (next !== "uploaded") onChange(next);
        }} disabled={disabled || reading} aria-label={label} />
        <label className={`button app-icon-upload ${disabled || reading ? "disabled" : ""}`}>
          <ImagePlus size={15} aria-hidden="true" />
          {reading ? "读取中…" : "上传图标"}
          <input className="app-icon-file" type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled || reading} onChange={upload} aria-label={`上传${label}`} />
        </label>
      </div>
      <p className="app-icon-picker-help">
        {selectedValue === "auto"
          ? preset
            ? `已匹配 ${preset.label}；修改${fallbackInitial ? "商家或网址" : "名称或官网"}会自动更新。`
            : fallbackInitial
              ? "按商家或网址匹配；未匹配时尝试网站图标，无法获取时显示商家首字母，未填商家时显示「云」。"
              : "按名称或官网匹配；未匹配时尝试官网图标，失败则显示通用图标。"
          : uploaded
            ? "使用你上传的图标。"
            : selectedValue === "generic" && fallbackInitial
              ? "使用商家首字母，未填商家时显示「云」。"
              : "使用手动选择的图标。"}
        <span>上传支持 PNG、JPEG、WebP，最大 64 KB。</span>
      </p>
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  );
}
