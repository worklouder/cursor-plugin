#!/usr/bin/env python3
"""Build the native Cursor plugin ZIP."""
import json
from pathlib import Path
from shutil import copyfile
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
package = json.loads((root / 'package.json').read_text())
destination = root / 'dist'
destination.mkdir(exist_ok=True)
plugin_output = destination / f"{package['name']}-{package['version']}-plugin.zip"


def add_item(archive, source, archive_path):
    """Add a file or directory as regular files, never as local symlinks."""
    if source.is_file():
        archive.write(source, archive_path)
        return
    for file in sorted(source.rglob('*')):
        if file.is_file() and '__pycache__' not in file.parts:
            archive.write(file, archive_path / file.relative_to(source))


def runtime_dependencies():
    """Return the installed production packages needed by the InputKit adapter."""
    input_kit = (root / 'node_modules/@worklouder/input-kit').resolve()
    if not (input_kit / 'dist/cjs/index.js').is_file():
        raise RuntimeError('Install the project dependencies before packaging')
    input_package = json.loads((input_kit / 'package.json').read_text())
    runtime_fields = ['dependencies', 'optionalDependencies', 'peerDependencies']
    if input_package.get('name') != '@worklouder/input-kit' or any(input_package.get(field) for field in runtime_fields):
        raise RuntimeError('Installed InputKit package has an unexpected runtime contract')

    return [
        (input_kit, Path('node_modules/@worklouder/input-kit'),
         ['package.json', 'LICENSE', 'NOTICE', 'README.md', 'dist', 'docs', 'examples']),
    ]


def add_runtime_dependencies(archive, prefix):
    for package_root, package_path, items in runtime_dependencies():
        for item in items:
            source = package_root / item
            if source.exists():
                add_item(archive, source, prefix / package_path / item)


plugin_items = ['.cursor-plugin', 'assets', 'commands', 'src',
                'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE']


def build_plugin(output):
    prefix = Path(package['name'])
    with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
        for item in plugin_items:
            source = root / item
            add_item(archive, source, prefix / item)
        add_item(archive, root / 'mcp.json', prefix / 'mcp.json')
        add_item(archive, root / 'hooks/hooks.json', prefix / 'hooks/hooks.json')
        add_item(archive, root / 'scripts/run-cursor', prefix / 'scripts/run-cursor')
        windows_launcher = (root / 'scripts/run-cursor.cmd').read_text().replace('\r\n', '\n').replace('\n', '\r\n')
        archive.writestr(str(prefix / 'scripts/run-cursor.cmd'), windows_launcher)
        add_runtime_dependencies(archive, prefix)
    print(output)


build_plugin(plugin_output)

layer_output = destination / f"cursor-default-layer-{package['version']}.json"
copyfile(root / 'src/resources/layers/cursor-default.json', layer_output)
print(layer_output)
windows_layer_output = destination / f"cursor-default-layer-{package['version']}-windows.json"
windows_layer = json.loads((root / 'src/resources/layers/cursor-default.json').read_text())
windows_layer['os'] = [1]
windows_layer['layer']['os'] = 1
for action in windows_layer['actions']:
    action['os'] = 1
    for key_input in action['keyInputs']:
        if key_input['keycode'] == 'KC_LGUI':
            key_input['keycode'] = 'KC_LCTL'
windows_layer_output.write_text(json.dumps(windows_layer, indent=2) + '\n')
print(windows_layer_output)
