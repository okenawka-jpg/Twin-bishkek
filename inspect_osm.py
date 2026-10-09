"""Что именно скачано из OpenStreetMap: главные улицы, типы дорог, площади.
Запуск: python inspect_osm.py   (ничего не меняет, только печатает)"""
import geopandas as gpd

UTM = 32643  # метры для долготы Бишкека (зона 43N)
KEYS = {  # ключевые слова в названии → наша улица
    "Чуй": ["чуй"],
    "Манаса": ["манаса", "манас"],
    "Жибек Жолу": ["жибек"],
    "Ахунбаева": ["ахунбаев"],
    "Южная магистраль": ["южная магистраль", "южн"],
}

def section(t):
    print("\n=== " + t + " ===")

try:
    section("Граница города")
    b = gpd.read_file("data/raw/osm/boundary.geojson").to_crs(UTM)
    print("площадь:", round(b.area.sum() / 1e6), "км²")
except Exception as e:
    print("граница: ошибка:", e)

try:
    r = gpd.read_file("data/raw/osm/roads.geojson")
    # в части участков в ячейке лежит список (например, два типа дороги сразу): превращаем всё в обычный текст
    def _txt(v):
        if isinstance(v, (list, tuple, set)) or hasattr(v, "tolist"):
            return ", ".join(str(x) for x in (v.tolist() if hasattr(v, "tolist") else v))
        return str(v)
    for _c in r.columns:
        if _c != "geometry":
            r[_c] = r[_c].apply(_txt)
    r["km"] = r.to_crs(UTM).length / 1000
    section("Типы дорог (сколько км)")
    print(r.groupby("highway")["km"].sum().sort_values(ascending=False).head(8).round(0).to_string())
    section("Самые длинные названия")
    print(r[~r["name"].isin(["nan", "None", ""])].groupby("name")["km"].sum().sort_values(ascending=False).head(15).round(1).to_string())
    section("Наши главные улицы")
    for ours, words in KEYS.items():
        m = r[r["name"].str.lower().apply(lambda s: any(w in s for w in words))]
        if len(m):
            c = m.to_crs(4326).geometry.unary_union.centroid
            print(f"{ours}: {len(m)} участков, {m['km'].sum():.1f} км, центр ≈ {c.y:.4f}, {c.x:.4f}")
            print("   названия:", sorted(set(m["name"]))[:5])
        else:
            print(f"{ours}: НЕ НАЙДЕНО")
    section("Скорость и полосы (сколько участков с данными)")
    for col in ("maxspeed", "lanes"):
        print(col, ":", int((~r[col].isin(["nan", "None", ""])).sum()), "из", len(r))
except Exception as e:
    print("дороги: ошибка:", e)

try:
    section("Зелень и соцобъекты")
    g = gpd.read_file("data/raw/osm/green.geojson").to_crs(UTM)
    print("зелёных зон:", len(g), "общая площадь:", round(g.area.sum() / 1e6, 1), "км²")
    s = gpd.read_file("data/raw/osm/social.geojson")
    print(s["amenity"].value_counts().to_string())
except Exception as e:
    print("зелень/соцобъекты: ошибка:", e)
