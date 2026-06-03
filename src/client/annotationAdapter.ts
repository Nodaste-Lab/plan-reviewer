export async function loadAnnotationDependencies() {
  const [washi, finder, html2canvas] = await Promise.all([
    import('@washi-ui/core'),
    import('@medv/finder'),
    import('html2canvas')
  ]);
  return { washi, finder, html2canvas };
}
