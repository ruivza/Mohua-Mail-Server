// Display labels only: client metadata never establishes identity or permissions.
export function browserDeviceName(userAgent = "") {
  const ua = typeof userAgent === "string" ? userAgent.slice(0, 2048) : "";
  const system = /iPad/i.test(ua) ? "iPadOS"
    : /iPhone|iPod/i.test(ua) ? "iOS"
    : /Android/i.test(ua) ? "Android"
    : /Windows/i.test(ua) ? "Windows"
    : /Macintosh|Mac OS X/i.test(ua) ? "macOS"
    : /Linux/i.test(ua) ? "Linux" : null;
  const browser = /Edg(?:e|A|iOS)?\//i.test(ua) ? "Edge"
    : /OPR\/|Opera/i.test(ua) ? "Opera"
    : /Firefox\/|FxiOS\//i.test(ua) ? "Firefox"
    : /Chrome\/|CriOS\//i.test(ua) ? "Chrome"
    : /Safari\//i.test(ua) ? "Safari" : "浏览器";
  return system ? `${browser} · ${system}` : browser;
}

export function iosDeviceName(info) {
  const model = ["iPhone", "iPad", "iPod touch", "Mac"].includes(info?.model)
    ? info.model : "iOS 设备";
  const system = model === "iPad" ? "iPadOS" : model === "Mac" ? "macOS" : "iOS";
  const version = typeof info?.systemVersion === "string"
    && /^\d{1,3}(?:\.\d{1,3}){0,2}$/.test(info.systemVersion)
    ? info.systemVersion : null;
  return version ? `${model} · ${system} ${version}` : model;
}
