"""The atlas and the reduction that depends on it.

Every product axis a creator sees is a mean over the vertices this atlas assigns,
so a wrong atlas is not a crash — it is five plausible-looking numbers about the
wrong parts of the brain. These tests exist to make that failure loud.

Run from `apps/ml`:

    pytest tests/
"""

from __future__ import annotations

import numpy as np
import pytest

import parcellation
from atlas.axis_map import AXES, AXIS_NETWORKS, axis_masks, load_atlas, n_vertices

# fsaverage5, both hemispheres. TRIBE reports exactly this as `n_vertices`, and
# if the two ever disagree every band is computed over the wrong surface.
EXPECTED_VERTICES = 20_484


class TestAtlas:
    def test_covers_the_fsaverage5_surface(self):
        labels, _names = load_atlas()
        assert labels.shape == (EXPECTED_VERTICES,)
        assert n_vertices() == EXPECTED_VERTICES

    def test_labels_are_parcel_ids_within_the_name_table(self):
        labels, names = load_atlas()
        assert labels.min() >= 0  # 0 is the medial wall
        assert labels.max() == len(names) - 1

    def test_leaves_the_medial_wall_unassigned(self):
        labels, _names = load_atlas()
        covered = (labels > 0).mean()
        # The medial wall is genuinely unlabelled cortex; a parcellation claiming
        # ~100% coverage would mean the wall got folded into a real parcel.
        assert 0.85 < covered < 0.95

    @pytest.mark.parametrize("axis", AXES)
    def test_every_axis_resolves_to_real_vertices(self, axis):
        index = AXES.index(axis)
        count = int(axis_masks()[index].sum())
        assert count > 0, f"{axis} matched no parcels from {AXIS_NETWORKS[axis]}"

    def test_axes_do_not_overlap(self):
        masks = axis_masks()
        for i in range(len(AXES)):
            for j in range(i + 1, len(AXES)):
                shared = int((masks[i] & masks[j]).sum())
                assert shared == 0, f"{AXES[i]} and {AXES[j]} share {shared} vertices"

    def test_audio_is_auditory_cortex_only(self):
        """The reason this uses Schaefer rather than the raw 17-network solution.

        At the network level auditory cortex is inside SomMotB alongside hand and
        foot motor; the audio axis has to be the `Aud` sub-parcel or it measures
        mostly somatomotor activity.
        """
        labels, names = load_atlas()
        audio_parcels = {names[i] for i in np.unique(labels[axis_masks()[AXES.index("audio")]])}
        assert audio_parcels, "audio axis is empty"
        assert all("SomMotB_Aud" in name for name in audio_parcels)
        assert not any("SomMotB_Cent" in name or "SomMotB_S2" in name for name in audio_parcels)

    def test_spans_both_hemispheres(self):
        """A mask confined to one hemisphere means the right-hemisphere offset broke."""
        labels, names = load_atlas()
        for index, axis in enumerate(AXES):
            parcels = {names[i] for i in np.unique(labels[axis_masks()[index]])}
            assert any("_LH_" in name for name in parcels), f"{axis} has no left hemisphere"
            assert any("_RH_" in name for name in parcels), f"{axis} has no right hemisphere"


class TestAxisBands:
    def test_recovers_a_planted_signal_exactly(self):
        """The only end-to-end check that the masks index what they claim to."""
        masks = axis_masks()
        preds = np.zeros((8, EXPECTED_VERTICES))
        for index, _axis in enumerate(AXES):
            preds[:, masks[index]] = float(index + 1)

        bands = parcellation.axis_bands(preds)
        assert bands.shape == (8, len(AXES))
        for index, axis in enumerate(AXES):
            assert bands[:, index] == pytest.approx(index + 1), f"{axis} did not recover"

    def test_ignores_vertices_outside_every_axis(self):
        """Medial-wall noise must not leak into a score."""
        masks = axis_masks()
        assigned = masks.any(axis=0)
        preds = np.zeros((4, EXPECTED_VERTICES))
        preds[:, ~assigned] = 1e6

        bands = parcellation.axis_bands(preds)
        assert np.all(bands == 0)

    def test_rejects_the_wrong_surface(self):
        with pytest.raises(ValueError, match="vertices"):
            parcellation.axis_bands(np.zeros((4, 1000)))

    def test_rejects_a_transposed_array(self):
        # Would otherwise average happily and return meaningless numbers.
        with pytest.raises(ValueError, match="vertices"):
            parcellation.axis_bands(np.zeros((EXPECTED_VERTICES, 4)))

    def test_rejects_a_non_2d_array(self):
        with pytest.raises(ValueError, match="2-D"):
            parcellation.axis_bands(np.zeros(EXPECTED_VERTICES))


class TestClipMeans:
    def test_averages_each_axis_over_time(self):
        bands = np.array([[0.0, 10.0, 0.0, 0.0, 0.0], [2.0, 20.0, 0.0, 0.0, 0.0]])
        means = parcellation.clip_means(bands)
        assert means["visual"] == pytest.approx(1.0)
        assert means["audio"] == pytest.approx(15.0)

    def test_an_empty_clip_is_zero_not_nan(self):
        """A NaN here would become a null percentile nobody could explain."""
        means = parcellation.clip_means(np.empty((0, len(AXES))))
        assert set(means) == set(AXES)
        assert all(value == 0.0 for value in means.values())
