# The first import of the miner must happen through import_miner(), or it
# resolves its locales against pytest's cwd and fails; see helpers/vendor.py.
from helpers.vendor import import_miner

import_miner()
