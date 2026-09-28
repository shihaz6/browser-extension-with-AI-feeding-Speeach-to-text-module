(function installVoicePOSDoubleMetaphone(root, factory) {
  const api = factory();
  root.VoicePOSDoubleMetaphone = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis, function createVoicePOSDoubleMetaphone() {
  "use strict";

  function doubleMetaphone(value) {
    const word = String(value ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z]/g, "");
    if (!word) return ["", ""];

    let primary = "";
    let alternate = "";
    let index = /^(?:GN|KN|PN|WR|PS)/.test(word) ? 1 : 0;
    const at = (offset, text) => word.startsWith(text, offset);
    const isVowel = character => "AEIOUY".includes(character || "");
    const add = (first, second = first) => {
      primary += first;
      alternate += second;
    };

    while (index < word.length) {
      const current = word[index];
      const next = word[index + 1] || "";
      const next2 = word[index + 2] || "";

      if (isVowel(current)) {
        if (index === 0) add("A");
        index++;
      } else if (current === "B") {
        add("P");
        index += next === "B" ? 2 : 1;
      } else if (current === "Ç") {
        add("S");
        index++;
      } else if (current === "C") {
        if (at(index, "CH")) {
          if (at(index, "CHAE")) add("K", "X");
          else if (index === 0 && (at(index + 1, "HARAC") || at(index + 1, "HARIS"))) add("K");
          else if (at(index - 1, "ORCHES") || at(index - 1, "ARCHIT") || at(index - 1, "ORCHID")) add("K");
          else add("X", "K");
          index += 2;
        } else if (at(index, "CZ") && !at(index - 2, "WICZ")) {
          add("S", "X");
          index += 2;
        } else if (at(index + 1, "CIA")) {
          add("X");
          index += 3;
        } else if (at(index, "CC") && !(index === 1 && word[0] === "M")) {
          if ("IEH".includes(next2) && !at(index + 2, "HU")) add("X", "K");
          else add("K");
          index += 3;
        } else if ("IEY".includes(next)) {
          add("S");
          index += 2;
        } else if (at(index, "CK") || at(index, "CG") || at(index, "CQ")) {
          add("K");
          index += 2;
        } else {
          add("K");
          index += next === "C" || next === "K" || next === "Q" ? 2 : 1;
        }
      } else if (current === "D") {
        if (at(index, "DGE") || at(index, "DGI") || at(index, "DGY")) {
          add("J");
          index += 3;
        } else if (at(index, "DD") || at(index, "DT")) {
          add("T");
          index += 2;
        } else {
          add("T");
          index++;
        }
      } else if (current === "F") {
        add("F");
        index += next === "F" ? 2 : 1;
      } else if (current === "G") {
        if (at(index, "GH")) {
          const before = word[index - 1] || "";
          if (index > 0 && !isVowel(before)) add("K");
          else if (index === 0) add(at(index + 2, "I") ? "J" : "K");
          else if (index > 1 && "BHD".includes(word[index - 2])) add("");
          else if (index > 2 && word[index - 1] === "U" && "CGLRT".includes(word[index - 3])) add("F");
          else if (index > 0 && before !== "I") add("K");
          index += 2;
        } else if (at(index, "GN")) {
          add("N", "KN");
          index += 2;
        } else if ("IEY".includes(next)) {
          add("J", "K");
          index += next === "E" && next2 === "R" ? 2 : 2;
        } else {
          add("K");
          index += next === "G" ? 2 : 1;
        }
      } else if (current === "H") {
        if ((index === 0 || isVowel(word[index - 1])) && isVowel(next)) add("H");
        index++;
      } else if (current === "J") {
        if (at(index, "JOSE") || at(index, "SAN ")) add("J", "H");
        else if (index === 0 && !at(index, "JO")) add("J", "A");
        else add("J");
        index += next === "J" ? 2 : 1;
      } else if (current === "K") {
        add("K");
        index += next === "K" ? 2 : 1;
      } else if (current === "L") {
        add("L");
        index += next === "L" ? 2 : 1;
      } else if (current === "M") {
        add("M");
        index += next === "M" ? 2 : 1;
      } else if (current === "N") {
        add("N");
        index += next === "N" ? 2 : 1;
      } else if (current === "P") {
        if (next === "H") add("F");
        else add("P");
        index += next === "H" || next === "P" ? 2 : 1;
      } else if (current === "Q") {
        add("K");
        index += next === "Q" ? 2 : 1;
      } else if (current === "R") {
        add("R");
        index += next === "R" ? 2 : 1;
      } else if (current === "S") {
        if (at(index, "SH") || at(index, "SIO") || at(index, "SIA")) {
          add("X");
          index += at(index, "SH") ? 2 : 3;
        } else if (at(index, "SCH")) {
          add("X", "SK");
          index += 3;
        } else if (at(index, "SC")) {
          if ("IEY".includes(next2)) {
            add("S");
            index += 3;
          } else {
            add("SK");
            index += 3;
          }
        } else {
          add("S");
          index += next === "S" || next === "Z" ? 2 : 1;
        }
      } else if (current === "T") {
        if (at(index, "TION") || at(index, "TIA") || at(index, "TCH")) {
          add("X");
          index += at(index, "TCH") ? 3 : 3;
        } else if (at(index, "TH") || at(index, "TTH")) {
          add("0", "T");
          index += at(index, "TTH") ? 3 : 2;
        } else if (at(index, "TT") || at(index, "TD")) {
          add("T");
          index += 2;
        } else {
          add("T");
          index++;
        }
      } else if (current === "V") {
        add("F");
        index += next === "V" ? 2 : 1;
      } else if (current === "W") {
        if (at(index, "WR")) {
          add("R");
          index += 2;
        } else if (index === 0 && isVowel(next)) {
          add("A", "F");
          index++;
        } else if (isVowel(next)) {
          add("F");
          index++;
        } else index++;
      } else if (current === "X") {
        add(index === 0 ? "S" : "KS");
        index++;
      } else if (current === "Z") {
        if (next === "H") {
          add("J", "S");
          index += 2;
        } else {
          add("S", "TS");
          index += next === "Z" ? 2 : 1;
        }
      } else {
        index++;
      }
    }

    return [primary, alternate];
  }

  return Object.freeze({ doubleMetaphone });
});
