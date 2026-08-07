use std::fs;
use std::path::Path;

// `bundle.resources` maps `../build-sidecar/` into the app's
// `Contents/Resources`, and tauri-build checks that path during every
// `cargo build` -- debug and release alike, because this build script
// is what reads the config. But the directory is generated:
// `bin/stage-sidecar.js` fills it from `beforeBundleCommand`, which the
// Tauri CLI runs *after* the cargo build, and `bin/clean.js` deletes
// it. A missing resource path is a hard error there, so without this a
// clean checkout could not build the thing that generates it.
//
// Creating it empty is enough. A directory resource is walked, and a
// walk that yields no files is skipped rather than failing, so a debug
// build copies nothing. The bundler reads `../build-sidecar/` again
// after `beforeBundleCommand` has filled it, so the packaged app still
// gets the whole staged tree.
fn main() {
    let staging = Path::new("..").join("build-sidecar");
    if let Err(err) = fs::create_dir_all(&staging) {
        panic!("cannot create {}: {err}", staging.display());
    }

    tauri_build::build()
}
