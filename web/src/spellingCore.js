const baseWordSource = `
a able about above accept account across action actual add after again against agent ago ai all almost alone along already also always am amount an and another answer any anyone anything app are arena around art as ask at available away
back bad based be beautiful because become been before being best better between big bit board both bring build building built but by
call can care change check clear click client close cloud code coding college come coming communication company computer connect content control copy correct could create creating current
daily data day decision decisions deep default design desktop different digital do docs does doing done dont down drag each easy edit editor education either email enough every example
fact fast fear feature feedback few finally find first fix focus folder for from full functionality future
game get getting give gives go goal going good google great group guess
got had hand hard has have he help here hidden high him his hold home hosting how
i idea ideas if image images import improve in inside instead interface into is it its
just keep key kind know
last later learn learning left less let lets line link list listen live local long look looking lot
make making many max maybe me mean means menu mind mobile mode money more most move much my
name native need needs new next no not note notes now
of off on once one only open option or order other our out over own
paper paste people perfect physical picture pictures place plan point position possible project projects public put
real really reason receive receiving redo red remote research resize rich right rotate run rysunki
same save screen screenshot screenshots search see select selected selection send server setup share shift should show simple since small so software someone something sometimes sort space spell spelling start stay step still storage subscriptions system
tab take taking text than that the their them then there thing things think this through time tiny to today together tool top try two type
ui undo underline underlines up upload use used user using
version very video view visible valuable
wall want was way we web well what when where which while who why width with without word words work workflow working works world would write writing written wrong
you your yours
api auth backup browser channel channels chrome claude cloudflare codex css database dictionary faster figma gemini github html javascript json localhost miro notepad oauth openai opportunities opportunity postgres rysunek screenshots supabase sync vite windows
`;

const commonCorrections = new Map(
  Object.entries({
    accomodate: ["accommodate"],
    acheive: ["achieve"],
    adress: ["address"],
    alredy: ["already"],
    becuase: ["because"],
    beleive: ["believe"],
    betyter: ["better"],
    buisness: ["business"],
    cahnges: ["changes"],
    definately: ["definitely"],
    devleopment: ["development"],
    diferent: ["different"],
    doesnt: ["doesn't"],
    enviroment: ["environment"],
    feauture: ["feature"],
    functiuonality: ["functionality"],
    goverment: ["government"],
    imporant: ["important"],
    iprobve: ["improve"],
    jsut: ["just"],
    justr: ["just"],
    knwo: ["know"],
    lenght: ["length"],
    necesary: ["necessary"],
    occured: ["occurred"],
    oportunities: ["opportunities"],
    oportunity: ["opportunity"],
    oppurtunities: ["opportunities"],
    oppurtunity: ["opportunity"],
    poisition: ["position"],
    recieve: ["receive"],
    recieving: ["receiving"],
    rpevious: ["previous"],
    rysubnki: ["rysunki"],
    seperate: ["separate"],
    seperateley: ["separately"],
    similiar: ["similar"],
    simpelst: ["simplest"],
    smth: ["something"],
    teh: ["the"],
    thier: ["their"],
    wierd: ["weird"],
    wouldnt: ["wouldn't"],
    youre: ["you're"],
  })
);

function normalizeWord(value) {
  return String(value || "")
    .toLocaleLowerCase()
    .replace(/^'+|'+$/g, "");
}

function loadWordSet(storageKey) {
  try {
    const words = JSON.parse(localStorage.getItem(storageKey) || "[]");
    return new Set(Array.isArray(words) ? words.map(normalizeWord).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function saveWordSet(storageKey, words) {
  localStorage.setItem(storageKey, JSON.stringify([...words].sort()));
}

function levenshtein(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[b.length];
}

function keepCase(suggestion, original) {
  if (original.toLocaleUpperCase() === original) {
    return suggestion.toLocaleUpperCase();
  }
  if (original[0]?.toLocaleUpperCase() === original[0]) {
    return `${suggestion[0].toLocaleUpperCase()}${suggestion.slice(1)}`;
  }
  return suggestion;
}

export function createSpellService(storageKey) {
  const baseWords = new Set(baseWordSource.split(/\s+/).map(normalizeWord).filter(Boolean));
  const personalWords = loadWordSet(storageKey);
  const ignoredWords = new Set();
  const suggestionWords = new Set([...baseWords, ...commonCorrections.values()].flat());

  function isKnownCorrect(word) {
    if (!word || word.length <= 1) return true;
    if (/\d/.test(word)) return true;
    if (/^https?$|^www$|^com$/.test(word)) return true;
    if (baseWords.has(word) || personalWords.has(word) || ignoredWords.has(word)) return true;
    if (suggestionWords.has(word)) return true;
    if (word.endsWith("'s") && isKnownCorrect(word.slice(0, -2))) return true;
    if (word.endsWith("s") && word.length > 3 && isKnownCorrect(word.slice(0, -1))) return true;
    if (word.endsWith("ed") && word.length > 4 && isKnownCorrect(word.slice(0, -2))) return true;
    if (word.endsWith("ing") && word.length > 5 && isKnownCorrect(word.slice(0, -3))) return true;
    return false;
  }

  function fuzzySuggestions(word, rawWord) {
    if (word.length < 5) {
      return [];
    }

    const maxDistance = word.length <= 5 ? 1 : 2;
    const items = [...suggestionWords, ...personalWords]
      .filter((candidate) => candidate[0] === word[0] && Math.abs(candidate.length - word.length) <= 2)
      .map((candidate) => ({
        candidate,
        distance: levenshtein(word, candidate),
      }))
      .filter((item) => item.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));

    if (!items.length || (items[1] && items[0].distance === items[1].distance)) {
      return [];
    }

    return items.slice(0, 3).map((item) => keepCase(item.candidate, rawWord));
  }

  function isCorrect(rawWord) {
    const word = normalizeWord(rawWord);
    if (isKnownCorrect(word)) return true;
    return !commonCorrections.has(word) && !fuzzySuggestions(word, rawWord).length;
  }

  function suggestions(rawWord) {
    const word = normalizeWord(rawWord);
    if (!word) return [];
    if (commonCorrections.has(word)) {
      return commonCorrections.get(word).map((suggestion) => keepCase(suggestion, rawWord));
    }
    if (isCorrect(word)) return [];
    return [...new Set(fuzzySuggestions(word, rawWord))];
  }

  function add(rawWord) {
    const word = normalizeWord(rawWord);
    if (!word) return "";
    personalWords.add(word);
    saveWordSet(storageKey, personalWords);
    return word;
  }

  function remove(rawWord) {
    const word = normalizeWord(rawWord);
    if (!word) return "";
    personalWords.delete(word);
    saveWordSet(storageKey, personalWords);
    return word;
  }

  function ignore(rawWord) {
    const word = normalizeWord(rawWord);
    if (word) ignoredWords.add(word);
    return word;
  }

  function unignore(rawWord) {
    const word = normalizeWord(rawWord);
    if (word) ignoredWords.delete(word);
    return word;
  }

  return {
    isCorrect,
    suggestions,
    add,
    remove,
    ignore,
    unignore,
  };
}
