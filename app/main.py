"""Streamlit-интерфейс Twin Bishkek.   streamlit run app/main.py

Тема из дизайна: скопируйте design/streamlit/config.toml в .streamlit/config.toml.
Считает напрямую через twin_bishkek.simulator (быстро, ~2 мс); если нужен отдельный
бэкенд — вместо импорта ходите в FastAPI (`requests.post(".../simulate", json=...)`).
"""
import streamlit as st

from map_view import build_deck
from twin_bishkek import city as C
from twin_bishkek.simulator import aqi_from_pm, defaults, get_simulator, preset_params

st.set_page_config(page_title="Twin Bishkek", layout="wide")


@st.cache_resource
def sim():
    return get_simulator()


S = sim()
st.sidebar.title("▲ Twin Bishkek")
preset = st.sidebar.selectbox("Пресет", ["— свой сценарий —"] + [f"{p['code']} · {p['name']}" for p in C.PRESETS])
init = preset_params(C.PRESETS[[f"{p['code']} · {p['name']}" for p in C.PRESETS].index(preset)]["id"]) \
    if preset != "— свой сценарий —" else defaults()

season = st.sidebar.segmented_control("Сезон", ["summer", "winter"], default=init["season"],
                                      format_func=lambda s: "Лето" if s == "summer" else "Зима") or "summer"
fleet = st.sidebar.slider("Автопарк, %", -30, 50, int(init["fleet"]), key=f"fleet-{preset}")
ev = st.sidebar.slider("Доля EV, %", 0, 100, int(init["ev"]), key=f"ev-{preset}")
green = st.sidebar.slider("Зелень, %", -30, 30, int(init["green"]), key=f"green-{preset}")
match = st.sidebar.toggle("Матч на стадионе", init["events"]["match"], key=f"m-{preset}")
venue = st.sidebar.selectbox("Стадион", list(C.STADIUMS), format_func=lambda k: C.STADIUMS[k]["name"], disabled=not match) if match else C.DEFAULT_VENUE
bridge = st.sidebar.selectbox("Ремонт моста", [None, *C.BRIDGES], format_func=lambda k: "нет" if k is None else C.BRIDGES[k]["name"])
closure = st.sidebar.selectbox("Перекрытие улицы", [None, *C.CLOSURES], index=([None, *C.CLOSURES].index(init["events"]["closure"])),
                               format_func=lambda k: "нет" if k is None else C.CLOSURES[k]["name"])

params = dict(season=season, fleet=fleet, ev=ev, green=green, objects=init["objects"],
              events=dict(match=match, bridge=bridge, closure=closure, venue=venue))
base, res = S.simulate(defaults(season)), S.simulate(params)

c1, c2, c3, c4 = st.columns(4)
for col, label, key, unit, fmt in [(c1, "AQI", "aqi", "", "{:.0f}"), (c2, "Задержка", "delay", "мин", "{:.1f}"),
                                   (c3, "Скорость", "speed", "км/ч", "{:.1f}"), (c4, "Urban Comfort", "comfort", "", "{:.0f}")]:
    col.metric(label, f"{fmt.format(res.city[key])} {unit}".strip(), f"{res.city[key] - base.city[key]:+.1f}",
               delta_color="off" if key == "speed" else ("normal" if key == "comfort" else "inverse"))
st.subheader(f"{res.vis['verdict']} · {res.vis['value']:.0%}")

left, right = st.columns(2)
left.caption("Сегодня")
left.pydeck_chart(build_deck(S, base), height=520)
right.caption("Если… (слой Δ AQI)")
mode = right.toggle("Разница к «Сегодня»", True)
right.pydeck_chart(build_deck(S, res, base if mode else None), height=520)
st.caption("Демо-калибровка. Улицы и реки — OpenStreetMap; границы районов условные; пробки — расчёт модели, не онлайн-данные.")
