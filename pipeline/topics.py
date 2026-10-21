"""Topic classification from GDELT Global Knowledge Graph themes.

GKG tags every article with themes such as ECON_INFLATION, TAX_FNCACT_FARMERS,
WB_621_HEALTH_NUTRITION_AND_POPULATION or NATURAL_DISASTER_FLOOD. Themes are
split on "_" and matched against keyword tokens below. A keyword ending in "*"
matches any token starting with it.

Topic ids (index matters; the front end uses the same order). Index 10 is
"other" for articles whose themes match no topic.
"""

TOPIC_IDS = ["politics", "economy", "technology", "health", "environment", "disasters",
             "agriculture", "energy", "crime", "society", "other"]
OTHER = 10

KEYWORDS = {
    0: "ELECTION* VOTE* VOTING LEGISLATION LEGISLAT* PARLIAMENT* DEMOCRACY POLITIC* REFERENDUM CONSTITUTION* "
       "LEADER PRESIDENT* MINISTER* GOVERNMENT* SENATE CONGRESS CABINET OPPOSITION CAMPAIGN* DIPLOMAC* SOVEREIGNTY",
    1: "ECON ECONOMY* ECONOMIC* INFLATION UNEMPLOYMENT JOBS STOCKMARKET STOCK* MARKET* BANK* BANKING FINANC* "
       "TRADE TARIFF* INVEST* MACROECONOMIC* BUSINESS* COMPANY* CORPORATE* CURRENCY DEBT BUDGET* TAXATION "
       "RECESSION GDP EXPORT* IMPORT* PRICE* WAGE* RETAIL* REALESTATE HOUSING",
    2: "TECH TECHNOLOGY* CYBER* INTERNET* SCIENCE* SCIENTIF* SPACE SATELLITE* DIGITAL* TELECOM* "
       "INNOVATION ROBOT* SOFTWARE COMPUTER* AI ARTIFICIAL SEMICONDUCTOR* HACK* DATA",
    3: "HEALTH* MEDIC* DISEASE* EPIDEMIC* PANDEMIC* VACCIN* HOSPITAL* DOCTOR* NURSE* CANCER VIRUS* "
       "MENTAL OUTBREAK* MALARIA HIV AIDS CHOLERA EBOLA COVID* INFLUENZA OBESITY NUTRITION",
    4: "ENV CLIMATE* POLLUTION WILDLIFE CONSERVATION DEFORESTATION EMISSION* BIODIVERSITY ENVIRONMENT* "
       "CARBON PLASTIC* RECYCLING ENDANGERED OCEAN* WATER",
    5: "DISASTER* FLOOD* EARTHQUAKE* HURRICANE* CYCLONE* TYPHOON* WILDFIRE* TORNADO* TSUNAMI* VOLCAN* "
       "DROUGHT* LANDSLIDE* HEATWAVE WEATHER STORM* EVACUATION* AVALANCHE BLIZZARD",
    6: "AGRICULTURE* AGRICULTURAL FARM* FARMER* CROP* FOOD* LIVESTOCK HARVEST* FISHER* FISHING FAMINE "
       "IRRIGATION FERTILIZER* GRAIN* WHEAT RICE",
    7: "ENERGY OIL NATURALGAS GAS ELECTRICITY POWER POWEROUTAGE SOLAR WINDPOWER NUCLEARPOWER FUEL* COAL "
       "RENEWABLE* PETROL* PIPELINE* OPEC",
    8: "CRIME* CRIMINAL KILL MURDER* ARREST* POLICE TRIAL JUSTICE DRUG* TRAFFICKING KIDNAP* ROBBERY THEFT "
       "FRAUD* CORRUPTION SMUGGLING GANG* PRISON* PRISONER* SENTENCE* LAWSUIT LEGAL",
    9: "EDUCATION* SCHOOL* UNIVERSIT* STUDENT* RELIGION* RELIGIOUS CHURCH* SPORT* SOCCER FOOTBALL OLYMPIC* "
       "MUSIC* FILM* MOVIE* ARTS CULTURE* CULTURAL TOURISM CELEBRITY ENTERTAINMENT* REFUGEE* IMMIGRA* "
       "MIGRA* LGBT* WOMEN GENDER CHILDREN YOUTH HERITAGE",
}

# Themes too generic to say anything about topic.
IGNORE_PREFIXES = ("TAX_WORLDLANGUAGES", "TAX_ETHNICITY", "TAX_WORLDMAMMALS", "TAX_WORLDBIRDS",
                   "TAX_WORLDREPTILES", "TAX_WORLDFISH", "CRISISLEX_CRISISLEXREC", "SOC_POINTSOFINTEREST",
                   "GENERAL_GOVERNMENT", "MEDIA_MSM", "USPEC_POLICY1")

_EXACT: dict[str, set[int]] = {}
_PREFIX: list[tuple[str, int]] = []
for _t, _words in KEYWORDS.items():
    for _w in _words.split():
        if _w.endswith("*"):
            _PREFIX.append((_w[:-1], _t))
        else:
            _EXACT.setdefault(_w, set()).add(_t)


def classify(themes: list[str], max_topics: int = 2) -> list[int]:
    hits = [0] * OTHER
    for theme in themes:
        if not theme or theme.startswith(IGNORE_PREFIXES):
            continue
        matched = set()
        for tok in theme.split("_"):
            if len(tok) < 2:
                continue
            matched |= _EXACT.get(tok, set())
            for pre, t in _PREFIX:
                if tok.startswith(pre):
                    matched.add(t)
        for t in matched:
            hits[t] += 1
    best = max(hits)
    if best == 0:
        return [OTHER]
    ranked = sorted(range(OTHER), key=lambda t: -hits[t])
    return [t for t in ranked[:max_topics] if hits[t] >= max(1, best * 0.5)]
