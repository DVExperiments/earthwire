"""CAMEO event codes used by GDELT, and how Earthwire groups them into map categories.

Category ids (index matters, the front end uses the same order):
  0 conflict    - violence and armed conflict          (CAMEO 18, 19, 20)
  1 security    - force posture, arrests, coercion     (CAMEO 15, 17)
  2 protest     - demonstrations, strikes, riots       (CAMEO 14)
  3 tension     - accusations, demands, threats, cuts  (CAMEO 09-13, 16)
  4 diplomacy   - statements, appeals, talks, deals    (CAMEO 01-05)
  5 cooperation - material cooperation, aid, release   (CAMEO 06-08)
"""

CATEGORY_IDS = ["conflict", "security", "protest", "tension", "diplomacy", "cooperation"]

ROOT_TO_CATEGORY = {
    "01": 4, "02": 4, "03": 4, "04": 4, "05": 4,
    "06": 5, "07": 5, "08": 5,
    "09": 3, "10": 3, "11": 3, "12": 3, "13": 3, "16": 3,
    "14": 2,
    "15": 1, "17": 1,
    "18": 0, "19": 0, "20": 0,
}

ROOT = {
    "01": "Made a public statement", "02": "Appealed", "03": "Expressed intent to cooperate",
    "04": "Consulted", "05": "Diplomatic cooperation", "06": "Material cooperation",
    "07": "Provided aid", "08": "Yielded", "09": "Investigated", "10": "Demanded",
    "11": "Disapproved", "12": "Rejected", "13": "Threatened", "14": "Protest",
    "15": "Military posturing", "16": "Reduced relations", "17": "Coercion",
    "18": "Assault", "19": "Armed fighting", "20": "Mass violence",
}

BASE = {
    "010": "Made a statement", "011": "Declined to comment", "012": "Made a pessimistic comment",
    "013": "Made an optimistic comment", "014": "Considered a policy option",
    "015": "Claimed responsibility", "016": "Denied responsibility", "017": "Symbolic act",
    "018": "Expressed sympathy", "019": "Expressed agreement",
    "020": "Made an appeal", "021": "Appealed for cooperation", "022": "Appealed for diplomatic cooperation",
    "023": "Appealed for aid", "024": "Appealed for political reform", "025": "Appealed to yield",
    "026": "Called for talks", "027": "Called for a settlement", "028": "Called for mediation",
    "030": "Signalled intent to cooperate", "031": "Signalled economic cooperation",
    "032": "Signalled diplomatic cooperation", "033": "Pledged aid", "034": "Pledged political reform",
    "035": "Signalled concessions", "036": "Agreed to meet or negotiate", "037": "Agreed to settle a dispute",
    "038": "Accepted mediation", "039": "Offered to mediate",
    "040": "Held consultations", "041": "Held a phone call", "042": "Made a visit", "043": "Hosted a visit",
    "044": "Met at a third location", "045": "Mediated", "046": "Negotiated",
    "050": "Diplomatic cooperation", "051": "Praised or endorsed", "052": "Defended verbally",
    "053": "Rallied support", "054": "Granted diplomatic recognition", "055": "Apologised",
    "056": "Forgave", "057": "Signed an agreement",
    "060": "Material cooperation", "061": "Economic cooperation", "062": "Military cooperation",
    "063": "Judicial cooperation", "064": "Shared intelligence",
    "070": "Provided aid", "071": "Provided economic aid", "072": "Provided military aid",
    "073": "Provided humanitarian aid", "074": "Provided peacekeeping", "075": "Granted asylum",
    "080": "Yielded", "081": "Eased administrative sanctions", "082": "Eased restrictions on dissent",
    "083": "Accepted political reform", "084": "Released people or property", "085": "Eased economic sanctions",
    "086": "Allowed international involvement", "087": "De-escalated military action",
    "090": "Investigated", "091": "Investigated crime or corruption", "092": "Investigated rights abuses",
    "093": "Investigated military action", "094": "Investigated war crimes",
    "100": "Made demands", "101": "Demanded cooperation", "102": "Demanded diplomatic cooperation",
    "103": "Demanded aid", "104": "Demanded political reform", "105": "Demanded concessions",
    "106": "Demanded a meeting", "107": "Demanded a settlement", "108": "Demanded mediation",
    "110": "Disapproved", "111": "Criticised or denounced", "112": "Accused", "113": "Rallied opposition",
    "114": "Complained officially", "115": "Brought a lawsuit", "116": "Found guilty or liable",
    "120": "Rejected", "121": "Rejected cooperation", "122": "Rejected a request for aid",
    "123": "Rejected political reform", "124": "Refused to yield", "125": "Rejected talks",
    "126": "Rejected mediation", "127": "Rejected a settlement plan", "128": "Defied norms or law",
    "129": "Vetoed",
    "130": "Threatened", "131": "Threatened non-force measures", "132": "Threatened sanctions",
    "133": "Threatened political dissent", "134": "Threatened to halt talks", "135": "Threatened to halt mediation",
    "136": "Threatened to halt international involvement", "137": "Threatened repression",
    "138": "Threatened military force", "139": "Issued an ultimatum",
    "140": "Political dissent", "141": "Demonstration or rally", "142": "Hunger strike",
    "143": "Strike or boycott", "144": "Blockade or obstruction", "145": "Violent protest or riot",
    "150": "Military posturing", "151": "Raised police alert", "152": "Raised military alert",
    "153": "Mobilised police", "154": "Mobilised armed forces", "155": "Mobilised cyber forces",
    "160": "Reduced relations", "161": "Cut diplomatic relations", "162": "Cut material aid",
    "163": "Imposed sanctions or embargo", "164": "Halted negotiations", "165": "Halted mediation",
    "166": "Expelled inspectors or peacekeepers",
    "170": "Coercion", "171": "Seized or damaged property", "172": "Imposed administrative sanctions",
    "173": "Arrests or charges", "174": "Expulsion or deportation", "175": "Violent repression",
    "176": "Cyberattack",
    "180": "Unconventional violence", "181": "Abduction or hostage-taking", "182": "Physical assault",
    "183": "Bombing", "184": "Used human shields", "185": "Attempted assassination", "186": "Assassination",
    "190": "Military force", "191": "Imposed a blockade", "192": "Occupied territory",
    "193": "Small-arms fighting", "194": "Artillery or tank fighting", "195": "Air strikes",
    "196": "Ceasefire violation",
    "200": "Mass violence", "201": "Mass expulsion", "202": "Mass killing", "203": "Ethnic cleansing",
    "204": "Weapons of mass destruction",
}


def describe(event_code: str, base_code: str, root_code: str) -> str:
    return BASE.get(base_code) or BASE.get((event_code or "")[:3]) or ROOT.get(root_code, "Event")
