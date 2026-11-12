"""Fixed-language packages. Add a locales/<tag>.json catalog to build another language."""
# Translation by: 抖音 小白科技杂物社 / BiliBili 小白151 / GitHub JackieZ123430
import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
LOCALES = ROOT / 'kit/runtime/locales'


def zh_credit(app_id=None):
    """The translation credit (corner, settings rows, entry comment): Chinese (zh-CN) builds only."""
    path = ROOT / 'kit/localization'
    name = 'credit.spotify.zh-CN.json' if app_id == 'spotify' else 'credit.zh-CN.json'
    return json.loads((path / name).read_text(encoding='utf-8'))


def languages():
    return ['en'] + sorted(p.stem for p in LOCALES.glob('*.json') if p.stem != 'en')


def load_locale(language, app_id=None):
    if language not in languages():
        raise ValueError('Unknown language: ' + language)
    if language == 'en':
        return {}
    path = ROOT / 'apps/spotify/zh-CN.json' if language == 'zh-CN' and app_id == 'spotify' else LOCALES / (language + '.json')
    return json.loads(path.read_text(encoding='utf-8'))


def text(value, words):
    s = str(value)
    return words.get(s, s).replace(' (default)', ' ' + words.get('(default)', '(default)'))


def package_version(version, language, app_id=None):
    revisions = json.loads((Path(__file__).parent / 'locale-revisions.json').read_text(encoding='utf-8'))
    revision = revisions.get('%s:%s' % (app_id, language), revisions.get(language, 1))
    return version if language == 'en' else version + '-' + language.lower().replace('-', '.') + '.' + str(revision)


def localize_spec(spec, language):
    words = load_locale(language, spec.get('id'))
    s = copy.deepcopy(spec)
    s['version'] = package_version(s['version'], language, spec.get('id'))
    s['title'] = text(s['title'], words)
    if language != 'en' and 'description' in s:
        s['description'] = text(s['description'], words)
    for screen in s.get('screens', []):
        if 'title' in screen:
            screen['title'] = text(screen['title'], words)
        for button in screen.get('buttons', []):
            button[1] = text(button[1], words)
        for item in screen.get('items', []):
            if len(item) > 2 and isinstance(item[2], str):
                item[2] = text(item[2], words)
    for setting in s.get('settings', []):
        setting['label'] = text(setting['label'], words)
        for option in setting.get('options', []):
            option[1] = text(option[1], words)
    return s


def unicode_resources(ui, strings, language='en', app_id=None):
    """Localize static resources; give initial Text cells stable Unicode StringIds."""
    words = load_locale(language, app_id)
    counter = [0]

    def visit(obj):
        if isinstance(obj, dict):
            value = obj.get('value')
            if obj.get('type') == 'Text' and isinstance(value, str) and value:
                sid = 'SID_CN_STATIC_%04d' % counter[0]
                counter[0] += 1
                strings[sid] = value
                obj.update(value=sid, type='StringId')
            else:
                for item in obj.values():
                    visit(item)
        elif isinstance(obj, list):
            for item in obj:
                visit(item)

    visit(ui)
    for key in strings:
        strings[key] = text(strings[key], words)
        if language == 'zh-CN' and key.endswith('_CN_CREDITS_TITLE'):
            strings[key] = zh_credit(app_id)['settingsTitle']
    for n in range(256):
        strings['SID_CN_DYNAMIC_%04d' % n] = ''
    if len(strings) > 1024:
        raise ValueError('HMI string bundle exceeds the verified 1024-resource budget')
