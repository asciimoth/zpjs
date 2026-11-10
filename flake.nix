{
  description = "Development environment for zpjs";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    git-hooks.url = "github:cachix/git-hooks.nix";
    git-hooks.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      git-hooks,
      ...
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      eachSystem = nixpkgs.lib.genAttrs systems;
      toolsFor = pkgs: [
        pkgs.nodejs_22
        pkgs.typescript
        pkgs.biome
        pkgs.just
      ];
    in
    {
      checks = eachSystem (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          jsCheck = pkgs.writeShellApplication {
            name = "zpjs-check";
            runtimeInputs = toolsFor pkgs;
            text = "just check-js";
          };
        in
        {
          node22 =
            pkgs.runCommand "zpjs-node22-check"
              {
                nativeBuildInputs = toolsFor pkgs;
                src = pkgs.lib.cleanSource ./.;
              }
              ''
                cp -r "$src" source
                chmod -R u+w source
                cd source
                just check-js
                just run
                touch "$out"
              '';
          pre-commit-check = git-hooks.lib.${system}.run {
            src = ./.;
            default_stages = [ "pre-commit" ];
            excludes = [ "^dist/" ];
            hooks = {
              check-added-large-files.enable = true;
              check-case-conflicts.enable = true;
              check-json.enable = true;
              check-merge-conflicts.enable = true;
              check-toml.enable = true;
              check-yaml.enable = true;
              commitizen.enable = true;
              deadnix.enable = true;
              end-of-file-fixer.enable = true;
              markdownlint.enable = true;
              nixfmt.enable = true;
              statix.enable = true;
              trim-trailing-whitespace.enable = true;
              typos.enable = true;
              just-fmt = {
                enable = true;
                name = "Justfile format";
                entry = "${pkgs.just}/bin/just --fmt --check";
                files = "^justfile$";
                pass_filenames = false;
              };
              js-check = {
                enable = true;
                name = "JavaScript build, types, lint, and tests";
                entry = "${jsCheck}/bin/zpjs-check";
                files = "(\\.[cm]?[jt]s$|^package\\.json$|^tsconfig.*\\.json$|^biome\\.json$|^justfile$)";
                pass_filenames = false;
                require_serial = true;
              };
            };
          };
        }
      );

      formatter = eachSystem (system: nixpkgs.legacyPackages.${system}.nixfmt);

      devShells = eachSystem (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          hook = self.checks.${system}.pre-commit-check;
        in
        {
          default = pkgs.mkShell {
            packages = toolsFor pkgs ++ hook.enabledPackages;
            inherit (hook) shellHook;
          };
        }
      );
    };
}
