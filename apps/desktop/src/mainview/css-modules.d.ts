declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}

// Electrobun's bun-side source imports `three` without types — silence it.
declare module "three";
