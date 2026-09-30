// 静态图片资源导入的类型声明（vite 构建期处理为 URL/base64）。
declare module '*.png' {
  const src: string;
  export default src;
}
declare module '*.svg' {
  const src: string;
  export default src;
}
