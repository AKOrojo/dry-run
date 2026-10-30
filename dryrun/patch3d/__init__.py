"""3D patch: a small OpenFOAM interFoam (VOF) solve nested one-way inside a finished 2D run (owner: Eng A).

geometry.py  patch grid, ground and building heights, the solid-cell mask
case.py      writes the OpenFOAM case (mesh, fields, boundary data from the 2D run)
post.py      reads the results: water depth, surface / mid-depth velocity, building forces, volume check
run.py       end to end, writing frames and a Patch3DManifest under runs/<run_id>/patch3d/<patch_id>/

The 2D run gives the water level and depth-averaged velocity on the patch edges over time (Dirichlet, one-way:
nothing feeds back). Outside dryrun/sim on purpose: it never changes SOLVER_VERSION or any run_id.
"""
