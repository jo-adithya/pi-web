import highlight from "highlight.js/lib/core";
import rust from "highlight.js/lib/languages/rust";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// Shared explicit grammars for Markdown and diffs; callers own their size budgets.
for (const [name, language] of Object.entries({ rust, javascript, typescript, json, bash, python, css, xml, yaml })) {
  highlight.registerLanguage(name, language);
}
export default highlight;
