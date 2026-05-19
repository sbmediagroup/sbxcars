const path = require('path');
const fs = require('fs/promises');
const sharp = require('sharp');

let sources = [
  'assets/images/alex/alex_car_palms.JPG',
  'assets/images/alex/alex_front_bentley_jeep.jpg',
  'assets/images/alex/alex_side_shot_smile.jpg'
];

// Add landing hero source so optimizer can produce public/images/landing/landing3-*.{avif,webp,jpg}
sources.push('assets/images/slides/landing3.jpg');

// If there are image sources under `public/images`, prefer scanning those
// and processing them instead of the committed `assets/` variants.
async function collectPublicSources(){
  const results = [];
  async function walk(dir){
    let items;
    try{ items = await fs.readdir(dir, { withFileTypes: true }); }catch(e){ return; }
    for(const it of items){
      const p = path.join(dir, it.name);
      if(it.isDirectory()) await walk(p);
      else if(/\.(jpe?g|png|JPG|JPEG)$/i.test(it.name)) results.push(p);
    }
  }
  const publicImages = path.join(process.cwd(),'public','images');
  await walk(publicImages);
  return results;
}

// Generate sizes including larger desktop variants to avoid upscaling
const widths = [320, 480, 768, 1024, 1600, 2048];
const jpegQuality = 72;
const webpQuality = 70;
const avifQuality = 50;

async function ensureDir(dir){
  try{ await fs.mkdir(dir, { recursive: true }); }catch(e){}
}

async function processImage(src, outBase, outDirName){
  const srcPath = path.resolve(src);
  // Write generated variants into `public/images/<folder>` so they
  // are not committed into the source `assets/` directory.
  const srcDir = path.dirname(src);
  const dirName = path.basename(srcDir); // e.g. 'alex'
  const dir = path.join(process.cwd(), 'public', 'images', outDirName || dirName);
  await ensureDir(dir);

  for(const w of widths){
    const pipeline = sharp(srcPath).resize({ width: w, withoutEnlargement: true });

    // AVIF
    const avifOut = path.join(dir, `${outBase}-${w}.avif`);
    await pipeline.clone().avif({ quality: avifQuality }).toFile(avifOut);

    // WebP
    const webpOut = path.join(dir, `${outBase}-${w}.webp`);
    await pipeline.clone().webp({ quality: webpQuality }).toFile(webpOut);

    // JPEG fallback
    const jpgOut = path.join(dir, `${outBase}-${w}.jpg`);
    await pipeline.clone().jpeg({ quality: jpegQuality }).toFile(jpgOut);
    console.log(`wrote: ${avifOut}, ${webpOut}, ${jpgOut}`);
  }
}

async function main(){
  // Prefer processing images placed under public/images (moved unused assets)
  const pub = await collectPublicSources();
  // Build a map of canonical bases -> candidate source files. If a
  // canonical base has multiple variants (e.g. -1600, -320), pick the
  // largest available as the source and emit deterministic outputs
  // named `canonicalBase-{width}.{ext}`.
  const candidates = (pub && pub.length) ? pub.map(p=> path.resolve(p)) : sources.map(s=> path.resolve(s));
  const map = new Map();
  for(const p of candidates){
    const ext = path.extname(p);
    const base = path.basename(p, ext);
    // canonical base: strip trailing -<digits> groups (e.g. -1600 or -320-1024)
    const canonical = base.replace(/(-\d+)+$/, '');
    // detect width if present
    const m = base.match(/-(\d+)$/);
    const width = m ? parseInt(m[1],10) : Number.POSITIVE_INFINITY;
    if(!map.has(canonical)) map.set(canonical, []);
    map.get(canonical).push({ path: p, width });
  }

  for(const [canonical, list] of map.entries()){
    // choose the file with the largest width (Infinity preferred)
    list.sort((a,b)=> (b.width - a.width));
    const src = list[0].path;
    try{
      await processImage(src, canonical);
    }catch(err){
      console.error('error processing', src, err.message);
    }
  }

  // Also ensure any explicit `sources` are processed into a sensible
  // directory. This handles cases where `public/images` already exists
  // so the earlier walk prioritized public assets and skipped sources.
  for(const s of sources){
    try{
      const p = path.resolve(s);
      // only process if source file exists
      try{ await fs.access(p); }catch(e){ continue; }
      const ext = path.extname(p);
      const base = path.basename(p, ext);
      const canonical = base.replace(/(-\d+)+$/, '');
      // special-case landing slide: write into `landing` directory
      if(/slides\/(landing|landing3)\.jpg$/i.test(s)){
        await processImage(p, 'landing3', 'landing');
      }else{
        await processImage(p, canonical);
      }
    }catch(err){ console.error('error processing source', s, err.message); }
  }
  console.log('done');
}

if(require.main === module) main();
