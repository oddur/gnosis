# Onest source font

`onest-variable.ttf` is the original variable font previously served by the website. License: [SIL Open Font License](../public/fonts/OFL-Onest.txt).

The site serves two WOFF2 subsets. Latin and common UI symbols load first; extended Latin and Cyrillic load only when the text needs them. The subsets preserve all 780 original Unicode mappings, horizontal metrics, and the 100–900 weight axis. They do not change the typeface design.

To regenerate:

```sh
python3 -m venv /tmp/gnosis-font-tools
/tmp/gnosis-font-tools/bin/pip install 'fonttools[woff]==4.68.0'
/tmp/gnosis-font-tools/bin/python site/scripts/build-fonts.py
npm run format --prefix site
```

The script generates `public/fonts/onest-{latin,extended}.woff2` and `src/styles/fonts.css`. It verifies full Unicode coverage and original metrics. Generated files are committed; Python is not needed to build or serve the site.
