# Changelog

## 1.2.0

- Centre a fitted part in the selected opening by default, with a Fill exactly preset for all dimensions and zero clearance. Separate placement remains available.
- Scope a loose negative Hole to its existing body so a newly centred insert is retained in the final geometry; keep a body-less hole as a hidden reference.
- Make Layer Library an explicit export destination, with connection setup available from the export flow.
- Keep the requested GitHub profile link available in the editor, including smaller layouts.
- Prepare the complete MIT-licensed public source package with GitHub upload instructions, bundled dependencies and automated checks.
- Support TrueNAS upgrades from both v1.0.0 and v1.1.0 while retaining projects, settings, port, backups and rollback behaviour.

## 1.1.0

- Fit a selected object to a cutting shape or tube opening, with adjustable clearance.
- Cut material below the build plane and create a closed, flat base while retaining editable source geometry.
- Control capsule top and bottom curvature independently, from flat through round to elongated ends.
- Upgrade an owned v1.0.0 TrueNAS installation while retaining its port, projects and settings. New images build before the existing app is stopped; database/config backups and application rollback cover activation failures.

## 1.0.0

- Initial self-hosted release with editable primitives, 3D transform handles, snapping, solid Boolean operations, STL import/export, project persistence and optional Layer Library integration.
